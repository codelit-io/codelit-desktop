use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{Ordering, compiler_fence};

const KEYCHAIN_SERVICE: &str = "io.codelit.desktop.provider-credentials.v1";
const MIN_SECRET_BYTES: usize = 8;
const MAX_SECRET_BYTES: usize = 8 * 1024;
const MAX_ACCOUNT_BYTES: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ByokProvider {
    OpenAi,
    Anthropic,
    Gemini,
}

impl ByokProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub const fn default_model(self) -> &'static str {
        match self {
            Self::OpenAi => "gpt-5.6-terra",
            Self::Anthropic => "claude-sonnet-5",
            Self::Gemini => "gemini-3.6-flash",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    InvalidAccount,
    InvalidSecret,
    #[allow(dead_code)]
    SecureStorageUnavailable,
    SecureStorageFailure,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidAccount => "The provider credential account is invalid.",
            Self::InvalidSecret => "The provider API key is invalid.",
            Self::SecureStorageUnavailable => "Provider credentials require the macOS Keychain.",
            Self::SecureStorageFailure => {
                "The provider credential could not be accessed in the macOS Keychain."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CredentialError {}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialRef {
    pub provider: ByokProvider,
    pub account: String,
}

impl fmt::Debug for ProviderCredentialRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderCredentialRef")
            .field("provider", &self.provider)
            .field("account", &"<redacted>")
            .finish()
    }
}

impl ProviderCredentialRef {
    pub fn new(
        provider: ByokProvider,
        account: impl Into<String>,
    ) -> Result<Self, CredentialError> {
        let account = account.into();
        if !valid_account(&account) {
            return Err(CredentialError::InvalidAccount);
        }
        Ok(Self { provider, account })
    }

    fn keychain_account(&self) -> String {
        format!("v1/{}/{}", self.provider.as_str(), self.account)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialStatus {
    pub provider: ByokProvider,
    pub account: String,
    pub configured: bool,
    pub available: bool,
    pub detail: String,
}

/// Owns an API key and wipes its allocation before release on a best-effort basis.
///
/// This type deliberately does not implement `Clone`, `Serialize`, or a revealing `Debug`.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn from_string(secret: String) -> Result<Self, CredentialError> {
        Self::from_bytes(secret.into_bytes())
    }

    pub fn from_bytes(secret: Vec<u8>) -> Result<Self, CredentialError> {
        if !valid_secret(&secret) {
            let mut rejected = secret;
            wipe(&mut rejected);
            return Err(CredentialError::InvalidSecret);
        }
        Ok(Self(secret))
    }

    pub(crate) fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBytes(<redacted>)")
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

pub trait CredentialBackend: Send + Sync {
    fn save(&self, account: &str, secret: &[u8]) -> Result<(), CredentialError>;
    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, CredentialError>;
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
}

pub struct ProviderCredentialStore<B = KeychainCredentialBackend> {
    backend: B,
}

impl Default for ProviderCredentialStore<KeychainCredentialBackend> {
    fn default() -> Self {
        Self::new(KeychainCredentialBackend)
    }
}

impl<B: CredentialBackend> ProviderCredentialStore<B> {
    pub const fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn save(
        &self,
        reference: &ProviderCredentialRef,
        secret: SecretBytes,
    ) -> Result<ProviderCredentialStatus, CredentialError> {
        self.backend
            .save(&reference.keychain_account(), secret.expose())?;
        Ok(status(reference, true))
    }

    /// Checks only whether a Keychain item exists. It never makes a metered API call.
    pub fn probe(
        &self,
        reference: &ProviderCredentialRef,
    ) -> Result<ProviderCredentialStatus, CredentialError> {
        let configured = self.load(reference)?.is_some();
        Ok(status(reference, configured))
    }

    /// Returns a non-secret readiness status even when secure storage is unavailable.
    /// A Keychain failure must not prevent the rest of the app from bootstrapping.
    pub fn probe_status(&self, reference: &ProviderCredentialRef) -> ProviderCredentialStatus {
        self.probe(reference)
            .unwrap_or_else(|error| unavailable_status(reference, error))
    }

    pub fn load(
        &self,
        reference: &ProviderCredentialRef,
    ) -> Result<Option<SecretBytes>, CredentialError> {
        let Some(secret) = self.backend.load(&reference.keychain_account())? else {
            return Ok(None);
        };
        SecretBytes::from_bytes(secret).map(Some)
    }

    pub fn delete(
        &self,
        reference: &ProviderCredentialRef,
    ) -> Result<ProviderCredentialStatus, CredentialError> {
        self.backend.delete(&reference.keychain_account())?;
        Ok(status(reference, false))
    }
}

fn status(reference: &ProviderCredentialRef, configured: bool) -> ProviderCredentialStatus {
    ProviderCredentialStatus {
        provider: reference.provider,
        account: reference.account.clone(),
        configured,
        available: true,
        detail: if configured {
            "API key is stored in macOS Keychain."
        } else {
            "No API key is stored in macOS Keychain."
        }
        .into(),
    }
}

fn unavailable_status(
    reference: &ProviderCredentialRef,
    error: CredentialError,
) -> ProviderCredentialStatus {
    ProviderCredentialStatus {
        provider: reference.provider,
        account: reference.account.clone(),
        configured: false,
        available: false,
        detail: error.to_string(),
    }
}

fn valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= MAX_ACCOUNT_BYTES
        && account.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b'+' | b'-')
        })
}

fn valid_secret(secret: &[u8]) -> bool {
    (MIN_SECRET_BYTES..=MAX_SECRET_BYTES).contains(&secret.len())
        && secret.iter().all(|byte| byte.is_ascii_graphic())
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: `byte` is a valid, uniquely borrowed byte in this allocation.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

#[derive(Debug, Clone, Copy, Default)]
pub struct KeychainCredentialBackend;

#[cfg(target_os = "macos")]
impl CredentialBackend for KeychainCredentialBackend {
    fn save(&self, account: &str, secret: &[u8]) -> Result<(), CredentialError> {
        use security_framework::passwords::set_generic_password_options;
        set_generic_password_options(secret, keychain_options(account))
            .map_err(|_| CredentialError::SecureStorageFailure)
    }

    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        use security_framework::passwords::generic_password;
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

        match generic_password(keychain_options(account)) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(CredentialError::SecureStorageFailure),
        }
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        use security_framework::passwords::delete_generic_password_options;
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

        match delete_generic_password_options(keychain_options(account)) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err(CredentialError::SecureStorageFailure),
        }
    }
}

#[cfg(target_os = "macos")]
fn keychain_options(account: &str) -> security_framework::passwords::PasswordOptions {
    let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        account,
    );
    options.set_access_synchronized(Some(false));
    options
}

#[cfg(not(target_os = "macos"))]
impl CredentialBackend for KeychainCredentialBackend {
    fn save(&self, _account: &str, _secret: &[u8]) -> Result<(), CredentialError> {
        Err(CredentialError::SecureStorageUnavailable)
    }

    fn load(&self, _account: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        Err(CredentialError::SecureStorageUnavailable)
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Err(CredentialError::SecureStorageUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryBackend {
        values: Mutex<HashMap<String, Vec<u8>>>,
    }

    struct UnavailableBackend;

    impl CredentialBackend for MemoryBackend {
        fn save(&self, account: &str, secret: &[u8]) -> Result<(), CredentialError> {
            self.values
                .lock()
                .unwrap()
                .insert(account.to_owned(), secret.to_vec());
            Ok(())
        }

        fn load(&self, account: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            Ok(self.values.lock().unwrap().get(account).cloned())
        }

        fn delete(&self, account: &str) -> Result<(), CredentialError> {
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    impl CredentialBackend for UnavailableBackend {
        fn save(&self, _account: &str, _secret: &[u8]) -> Result<(), CredentialError> {
            Err(CredentialError::SecureStorageFailure)
        }

        fn load(&self, _account: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            Err(CredentialError::SecureStorageFailure)
        }

        fn delete(&self, _account: &str) -> Result<(), CredentialError> {
            Err(CredentialError::SecureStorageFailure)
        }
    }

    fn reference(provider: ByokProvider) -> ProviderCredentialRef {
        ProviderCredentialRef::new(provider, "personal@example.com").unwrap()
    }

    #[test]
    fn namespaces_provider_accounts_without_collisions() {
        let openai = reference(ByokProvider::OpenAi);
        let anthropic = reference(ByokProvider::Anthropic);
        assert_eq!(openai.keychain_account(), "v1/openai/personal@example.com");
        assert_eq!(
            anthropic.keychain_account(),
            "v1/anthropic/personal@example.com"
        );
        assert_ne!(openai.keychain_account(), anthropic.keychain_account());
        assert_eq!(
            KEYCHAIN_SERVICE,
            "io.codelit.desktop.provider-credentials.v1"
        );
    }

    #[test]
    fn provider_ids_and_balanced_defaults_are_stable() {
        assert_eq!(ByokProvider::OpenAi.as_str(), "openai");
        assert_eq!(ByokProvider::OpenAi.default_model(), "gpt-5.6-terra");
        assert_eq!(ByokProvider::Anthropic.as_str(), "anthropic");
        assert_eq!(ByokProvider::Anthropic.default_model(), "claude-sonnet-5");
        assert_eq!(ByokProvider::Gemini.as_str(), "gemini");
        assert_eq!(ByokProvider::Gemini.default_model(), "gemini-3.6-flash");
    }

    #[test]
    fn rejects_unsafe_accounts_and_secrets() {
        assert_eq!(
            ProviderCredentialRef::new(ByokProvider::Gemini, "../default").unwrap_err(),
            CredentialError::InvalidAccount
        );
        assert_eq!(
            SecretBytes::from_string("contains a space".into()).unwrap_err(),
            CredentialError::InvalidSecret
        );
        assert_eq!(
            SecretBytes::from_string("short".into()).unwrap_err(),
            CredentialError::InvalidSecret
        );
    }

    #[test]
    fn save_probe_load_and_delete_stay_backend_scoped() {
        let store = ProviderCredentialStore::new(MemoryBackend::default());
        let reference = reference(ByokProvider::OpenAi);

        let missing = store.probe(&reference).unwrap();
        assert!(!missing.configured);
        assert!(missing.available);
        assert_eq!(missing.detail, "No API key is stored in macOS Keychain.");
        assert!(
            store
                .save(
                    &reference,
                    SecretBytes::from_string("sk-test-secret".into()).unwrap()
                )
                .unwrap()
                .configured
        );
        assert!(store.probe(&reference).unwrap().configured);
        assert_eq!(
            store.load(&reference).unwrap().unwrap().expose(),
            b"sk-test-secret"
        );
        assert!(!store.delete(&reference).unwrap().configured);
        assert!(!store.probe(&reference).unwrap().configured);
    }

    #[test]
    fn secure_storage_failure_becomes_an_unavailable_non_secret_status() {
        let store = ProviderCredentialStore::new(UnavailableBackend);
        let reference = reference(ByokProvider::Gemini);

        let status = store.probe_status(&reference);

        assert_eq!(status.provider, ByokProvider::Gemini);
        assert_eq!(status.account, "personal@example.com");
        assert!(!status.configured);
        assert!(!status.available);
        assert_eq!(
            status.detail,
            "The provider credential could not be accessed in the macOS Keychain."
        );
    }

    #[test]
    fn secret_debug_is_always_redacted() {
        let secret = SecretBytes::from_string("sk-test-secret".into()).unwrap();
        let rendered = format!("{secret:?}");
        assert_eq!(rendered, "SecretBytes(<redacted>)");
        assert!(!rendered.contains("sk-test"));
    }

    #[test]
    fn wipe_overwrites_every_byte() {
        let mut bytes = b"secret material".to_vec();
        wipe(&mut bytes);
        assert!(bytes.iter().all(|byte| *byte == 0));
    }
}
