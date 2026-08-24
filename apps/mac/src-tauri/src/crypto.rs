use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::sync::{Arc, RwLock};

const ENVELOPE_PREFIX: &str = "enc:v1:";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;

#[derive(Clone)]
pub struct DataCipher {
    key: Arc<RwLock<[u8; KEY_BYTES]>>,
}

impl DataCipher {
    pub fn new(key: [u8; KEY_BYTES]) -> Self {
        Self {
            key: Arc::new(RwLock::new(key)),
        }
    }

    pub fn replace_key(&self, key: [u8; KEY_BYTES]) -> Result<(), String> {
        *self
            .key
            .write()
            .map_err(|_| "Could not update the local encryption key.".to_string())? = key;
        Ok(())
    }

    pub fn seal(&self, context: &str, plaintext: &str) -> Result<String, String> {
        let key = self
            .key
            .read()
            .map_err(|_| "Could not read the local encryption key.".to_string())?;
        let cipher = Aes256Gcm::new_from_slice(key.as_slice())
            .map_err(|_| "Could not initialize local data encryption.".to_string())?;
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce)
            .map_err(|_| "Could not generate local encryption randomness.".to_string())?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| "Could not encrypt local workspace data.".to_string())?;
        let mut envelope = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(&ciphertext);
        Ok(format!(
            "{ENVELOPE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope)
        ))
    }

    pub fn open(&self, context: &str, stored: &str) -> Result<String, String> {
        let encoded = stored.strip_prefix(ENVELOPE_PREFIX).ok_or_else(|| {
            "Local workspace data is not encrypted with a supported format.".to_string()
        })?;
        let envelope = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Local workspace encryption data is malformed.".to_string())?;
        if envelope.len() <= NONCE_BYTES {
            return Err("Local workspace encryption data is incomplete.".into());
        }
        let (nonce, ciphertext) = envelope.split_at(NONCE_BYTES);
        let key = self
            .key
            .read()
            .map_err(|_| "Could not read the local encryption key.".to_string())?;
        let cipher = Aes256Gcm::new_from_slice(key.as_slice())
            .map_err(|_| "Could not initialize local data encryption.".to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| {
                "Local workspace data could not be decrypted. Restore the original Keychain item or import a backup."
                    .to_string()
            })?;
        String::from_utf8(plaintext)
            .map_err(|_| "Local workspace data is not valid UTF-8.".to_string())
    }

    pub fn is_sealed(value: &str) -> bool {
        value.starts_with(ENVELOPE_PREFIX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_body_round_trips_and_binds_to_its_row() {
        let cipher = DataCipher::new([7_u8; KEY_BYTES]);
        let sealed = cipher
            .seal("threads:local", r#"{"private":"value"}"#)
            .expect("seal");
        assert!(DataCipher::is_sealed(&sealed));
        assert!(!sealed.contains("private"));
        assert_eq!(
            cipher.open("threads:local", &sealed).expect("open"),
            r#"{"private":"value"}"#
        );
        assert!(cipher.open("threads:other", &sealed).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let cipher = DataCipher::new([11_u8; KEY_BYTES]);
        let mut sealed = cipher.seal("receipts:one", "evidence").expect("seal");
        sealed.push('A');
        assert!(cipher.open("receipts:one", &sealed).is_err());
    }
}
