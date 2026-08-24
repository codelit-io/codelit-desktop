use serde::Serialize;

pub const SCHEDULER_PLIST_NAME: &str = "io.codelit.desktop.scheduler.plist";
const DATA_KEY_SERVICE: &str = "io.codelit.desktop.local-data";
const DATA_KEY_ACCOUNT: &str = "workspace-encryption-v1";
const DATA_KEY_BYTES: usize = 32;
const CLOUD_KEY_SERVICE: &str = "io.codelit.desktop.cloud";

#[derive(Debug)]
pub struct FolderBookmark {
    pub path: String,
    pub bookmark: Vec<u8>,
    pub stale: bool,
    pub access_validated: bool,
}

#[derive(Debug)]
pub struct SelectedArchive {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundServiceProbe {
    pub status: String,
    pub bundled: bool,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct RunningApplicationInfo {
    pub bundle_id: String,
    pub name: String,
    pub active: bool,
    pub process_id: i32,
}

#[derive(Debug, Clone)]
pub struct ComputerDisplayInfo {
    pub x_bits: u64,
    pub y_bits: u64,
    pub width_bits: u64,
    pub height_bits: u64,
    pub awake: bool,
    pub online: bool,
}

#[derive(Debug, Clone)]
pub struct ComputerEnvironmentInfo {
    pub session_on_console: bool,
    pub screen_locked: bool,
    pub displays: Vec<ComputerDisplayInfo>,
}

#[cfg(target_os = "macos")]
mod platform {
    #[cfg(not(feature = "app-store-release"))]
    use super::ComputerDisplayInfo;
    use super::{
        BackgroundServiceProbe, CLOUD_KEY_SERVICE, ComputerEnvironmentInfo, DATA_KEY_ACCOUNT,
        DATA_KEY_BYTES, DATA_KEY_SERVICE, FolderBookmark, RunningApplicationInfo,
        SCHEDULER_PLIST_NAME, SelectedArchive,
    };
    #[cfg(not(feature = "app-store-release"))]
    use core::ffi::c_void;
    #[cfg(not(feature = "app-store-release"))]
    use core_foundation::base::{CFGetTypeID, TCFType};
    #[cfg(not(feature = "app-store-release"))]
    use core_foundation::boolean::CFBoolean;
    #[cfg(not(feature = "app-store-release"))]
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    #[cfg(not(feature = "app-store-release"))]
    use core_foundation::string::CFString;
    #[cfg(not(feature = "app-store-release"))]
    use core_graphics::geometry::CGRect;
    use objc2::MainThreadMarker;
    use objc2::runtime::Bool;
    #[cfg(not(feature = "app-store-release"))]
    use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy};
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSSavePanel, NSWorkspace};
    use objc2_foundation::{
        NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
    };
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use security_framework::passwords::{
        PasswordOptions, delete_generic_password_options, generic_password,
        set_generic_password_options,
    };
    use std::ffi::CString;
    use std::fs;
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

    #[cfg(not(feature = "app-store-release"))]
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    #[cfg(not(feature = "app-store-release"))]
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
        fn CGGetActiveDisplayList(
            max_displays: u32,
            active_displays: *mut u32,
            display_count: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGDisplayIsAsleep(display: u32) -> u32;
        fn CGDisplayIsOnline(display: u32) -> u32;
    }

    #[cfg(not(feature = "app-store-release"))]
    unsafe extern "C" {
        fn clock_gettime_nsec_np(clock_id: libc::clockid_t) -> u64;
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn accessibility_permission_granted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    #[cfg(feature = "app-store-release")]
    pub fn accessibility_permission_granted() -> bool {
        false
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn screen_capture_permission_granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    #[cfg(feature = "app-store-release")]
    pub fn screen_capture_permission_granted() -> bool {
        false
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn request_screen_capture_permission() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    #[cfg(feature = "app-store-release")]
    pub fn request_screen_capture_permission() -> bool {
        false
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn computer_environment() -> Result<ComputerEnvironmentInfo, String> {
        const MAX_ACTIVE_DISPLAYS: usize = 16;
        let session = unsafe { CGSessionCopyCurrentDictionary() };
        if session.is_null() {
            return Err("The macOS window-server session is unavailable.".into());
        }
        let session = unsafe {
            CFDictionary::<*const c_void, *const c_void>::wrap_under_create_rule(session)
        };
        let session_on_console =
            dictionary_bool(&session, "kCGSSessionOnConsoleKey").unwrap_or(false);
        let screen_locked = dictionary_bool(&session, "CGSSessionScreenIsLocked").unwrap_or(false);

        let mut display_ids = [0_u32; MAX_ACTIVE_DISPLAYS];
        let mut display_count = 0_u32;
        let error = unsafe {
            CGGetActiveDisplayList(
                MAX_ACTIVE_DISPLAYS as u32,
                display_ids.as_mut_ptr(),
                &mut display_count,
            )
        };
        if error != 0 || display_count as usize > MAX_ACTIVE_DISPLAYS {
            return Err("macOS could not inspect the active display configuration.".into());
        }
        let displays = display_ids[..display_count as usize]
            .iter()
            .map(|display| {
                let bounds = unsafe { CGDisplayBounds(*display) };
                ComputerDisplayInfo {
                    x_bits: bounds.origin.x.to_bits(),
                    y_bits: bounds.origin.y.to_bits(),
                    width_bits: bounds.size.width.to_bits(),
                    height_bits: bounds.size.height.to_bits(),
                    awake: unsafe { CGDisplayIsAsleep(*display) == 0 },
                    online: unsafe { CGDisplayIsOnline(*display) != 0 },
                }
            })
            .collect();
        Ok(ComputerEnvironmentInfo {
            session_on_console,
            screen_locked,
            displays,
        })
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn continuous_time_nanos() -> Result<u64, String> {
        Ok(unsafe { clock_gettime_nsec_np(libc::CLOCK_MONOTONIC_RAW) })
    }

    #[cfg(feature = "app-store-release")]
    pub fn continuous_time_nanos() -> Result<u64, String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    #[cfg(feature = "app-store-release")]
    pub fn computer_environment() -> Result<ComputerEnvironmentInfo, String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    #[cfg(not(feature = "app-store-release"))]
    fn dictionary_bool(
        dictionary: &CFDictionary<*const c_void, *const c_void>,
        key: &str,
    ) -> Option<bool> {
        let key = CFString::new(key);
        let value = dictionary.find(key.as_CFTypeRef())?;
        if unsafe { CFGetTypeID(*value) } != CFBoolean::type_id() {
            return None;
        }
        Some(bool::from(unsafe {
            CFBoolean::wrap_under_get_rule((*value).cast())
        }))
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn open_accessibility_settings() -> Result<(), String> {
        open_privacy_settings("Privacy_Accessibility")
    }

    #[cfg(feature = "app-store-release")]
    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    #[cfg(not(feature = "app-store-release"))]
    fn open_privacy_settings(pane: &str) -> Result<(), String> {
        let value = NSString::from_str(&format!(
            "x-apple.systempreferences:com.apple.preference.security?{pane}"
        ));
        let url = NSURL::URLWithString(&value)
            .ok_or_else(|| "macOS could not open Privacy & Security settings.".to_string())?;
        if !NSWorkspace::sharedWorkspace().openURL(&url) {
            return Err("macOS could not open Privacy & Security settings.".into());
        }
        Ok(())
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn list_running_applications() -> Vec<RunningApplicationInfo> {
        NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .filter(|app| {
                !app.isTerminated()
                    && app.activationPolicy() == NSApplicationActivationPolicy::Regular
            })
            .filter_map(|app| {
                let bundle_id = app.bundleIdentifier()?.to_string();
                let name = app.localizedName()?.to_string();
                Some(RunningApplicationInfo {
                    bundle_id,
                    name,
                    active: app.isActive(),
                    process_id: app.processIdentifier(),
                })
            })
            .collect()
    }

    #[cfg(feature = "app-store-release")]
    pub fn list_running_applications() -> Vec<RunningApplicationInfo> {
        Vec::new()
    }

    #[cfg(not(feature = "app-store-release"))]
    pub fn activate_application(bundle_id: &str) -> Result<(), String> {
        let application = NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .find(|app| {
                !app.isTerminated()
                    && app
                        .bundleIdentifier()
                        .is_some_and(|value| value.to_string() == bundle_id)
            })
            .ok_or_else(|| "Open the approved app before the bot uses it.".to_string())?;
        if !application.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
            return Err("macOS could not bring the approved app forward.".into());
        }
        Ok(())
    }

    #[cfg(feature = "app-store-release")]
    pub fn activate_application(_bundle_id: &str) -> Result<(), String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    pub fn load_or_create_data_key() -> Result<[u8; DATA_KEY_BYTES], String> {
        #[cfg(debug_assertions)]
        if let Some(key) = development_data_key()? {
            return Ok(key);
        }

        match generic_password(data_key_options()) {
            Ok(bytes) => bytes.try_into().map_err(|_| {
                "Codelit's local encryption key has an unexpected size. Restore the original Keychain item or reset local data."
                    .to_string()
            }),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {
                let key = generate_data_key()?;
                set_generic_password_options(&key, data_key_options()).map_err(|error| {
                    format!("Could not store Codelit's local encryption key in Keychain: {error}")
                })?;
                Ok(key)
            }
            Err(error) => Err(format!(
                "Could not read Codelit's local encryption key from Keychain: {error}"
            )),
        }
    }

    #[cfg(debug_assertions)]
    fn development_data_key() -> Result<Option<[u8; DATA_KEY_BYTES]>, String> {
        let Some(value) = std::env::var_os("CODELIT_DEV_DATA_KEY") else {
            return Ok(None);
        };
        let bytes = value.as_encoded_bytes();
        if bytes.len() != DATA_KEY_BYTES {
            return Err(format!(
                "CODELIT_DEV_DATA_KEY must contain exactly {DATA_KEY_BYTES} bytes."
            ));
        }
        let mut key = [0_u8; DATA_KEY_BYTES];
        key.copy_from_slice(bytes);
        Ok(Some(key))
    }

    pub fn replace_data_key() -> Result<[u8; DATA_KEY_BYTES], String> {
        match delete_generic_password_options(data_key_options()) {
            Ok(()) => {}
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            Err(error) => {
                return Err(format!(
                    "Could not remove Codelit's local encryption key from Keychain: {error}"
                ));
            }
        }
        let key = generate_data_key()?;
        set_generic_password_options(&key, data_key_options()).map_err(|error| {
            format!("Could not store Codelit's new local encryption key in Keychain: {error}")
        })?;
        Ok(key)
    }

    fn data_key_options() -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(DATA_KEY_SERVICE, DATA_KEY_ACCOUNT);
        options.set_access_synchronized(Some(false));
        options
    }

    fn cloud_key_options(account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(CLOUD_KEY_SERVICE, account);
        options.set_access_synchronized(Some(false));
        options
    }

    pub fn store_cloud_credential(account: &str, value: &[u8]) -> Result<(), String> {
        if account.is_empty() || account.len() > 80 || value.is_empty() || value.len() > 16 * 1024 {
            return Err("Codelit Cloud credential is invalid.".into());
        }
        match delete_generic_password_options(cloud_key_options(account)) {
            Ok(()) => {}
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            Err(error) => {
                return Err(format!(
                    "Could not replace Codelit Cloud access in Keychain: {error}"
                ));
            }
        }
        set_generic_password_options(value, cloud_key_options(account))
            .map_err(|error| format!("Could not store Codelit Cloud access in Keychain: {error}"))
    }

    pub fn load_cloud_credential(account: &str) -> Result<Option<Vec<u8>>, String> {
        match generic_password(cloud_key_options(account)) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!(
                "Could not read Codelit Cloud access from Keychain: {error}"
            )),
        }
    }

    pub fn delete_cloud_credential(account: &str) -> Result<(), String> {
        match delete_generic_password_options(cloud_key_options(account)) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!(
                "Could not remove Codelit Cloud access from Keychain: {error}"
            )),
        }
    }

    pub fn open_external_https(url: &str) -> Result<(), String> {
        let parsed = url::Url::parse(url)
            .map_err(|_| "Codelit Cloud returned an invalid browser link.".to_string())?;
        let production = parsed.scheme() == "https"
            && parsed.host_str() == Some("codelit.io")
            && parsed.port().is_none();
        #[cfg(debug_assertions)]
        let development = parsed.scheme() == "http" && parsed.host_str() == Some("localhost");
        #[cfg(not(debug_assertions))]
        let development = false;
        if !production && !development
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Codelit Cloud returned an untrusted browser link.".into());
        }
        let string = NSString::from_str(parsed.as_str());
        let ns_url = NSURL::URLWithString(&string)
            .ok_or_else(|| "Codelit Cloud returned an invalid browser link.".to_string())?;
        if !NSWorkspace::sharedWorkspace().openURL(&ns_url) {
            return Err("macOS could not open the Codelit connection page.".into());
        }
        Ok(())
    }

    fn generate_data_key() -> Result<[u8; DATA_KEY_BYTES], String> {
        let mut key = [0_u8; DATA_KEY_BYTES];
        getrandom::fill(&mut key)
            .map_err(|_| "Could not generate a local encryption key.".to_string())?;
        Ok(key)
    }

    pub fn choose_workspace_folder(
        purpose: Option<&str>,
    ) -> Result<Option<FolderBookmark>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The folder picker must be opened from the main app thread.".to_string()
        })?;
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        panel.setResolvesAliases(true);
        if purpose == Some("desktop") {
            panel.setTitle(Some(&NSString::from_str("Choose your Desktop")));
            panel.setMessage(Some(&NSString::from_str(
                "Codelit will list visible file and folder names using read-only access.",
            )));
            panel.setPrompt(Some(&NSString::from_str("Allow Read-Only Access")));
        } else {
            panel.setTitle(Some(&NSString::from_str("Choose a project folder")));
            panel.setMessage(Some(&NSString::from_str(
                "Codelit will inspect this project using read-only access.",
            )));
            panel.setPrompt(Some(&NSString::from_str("Choose Project")));
        }

        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the selected folder.".to_string())?;
        Ok(Some(bookmark_for_selected_url(&url)?))
    }

    pub fn choose_local_executable() -> Result<Option<String>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The executable picker must be opened from the main app thread.".to_string()
        })?;
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setCanChooseDirectories(false);
        panel.setCanChooseFiles(true);
        panel.setAllowsMultipleSelection(false);
        panel.setResolvesAliases(true);
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the selected executable.".to_string())?;
        let path = local_path(&url)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect the selected executable: {error}"))?;
        if !metadata.is_file() {
            return Err("Choose an executable file.".into());
        }
        Ok(Some(path))
    }

    pub fn save_workspace_archive(bytes: &[u8]) -> Result<Option<String>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The export panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSSavePanel::savePanel(main_thread);
        panel.setCanCreateDirectories(true);
        panel.setExtensionHidden(false);
        panel.setNameFieldStringValue(&NSString::from_str("Codelit Workspace.codelit"));
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the export location.".to_string())?;
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = write_atomic(Path::new(&path), bytes);
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result?;
        Ok(Some(path))
    }

    pub fn save_bot_table_csv(file_name: &str, bytes: &[u8]) -> Result<Option<String>, String> {
        if file_name.is_empty()
            || file_name.len() > 120
            || !file_name.ends_with(".csv")
            || file_name.contains(['/', '\\', '\0'])
        {
            return Err("The local table export name is invalid.".into());
        }
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The export panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSSavePanel::savePanel(main_thread);
        panel.setCanCreateDirectories(true);
        panel.setExtensionHidden(false);
        panel.setNameFieldStringValue(&NSString::from_str(file_name));
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the export location.".to_string())?;
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = write_atomic(Path::new(&path), bytes);
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result?;
        Ok(Some(path))
    }

    pub fn save_pilot_report(bytes: &[u8]) -> Result<Option<String>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The export panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSSavePanel::savePanel(main_thread);
        panel.setCanCreateDirectories(true);
        panel.setExtensionHidden(false);
        panel.setNameFieldStringValue(&NSString::from_str("Codelit Private Product Report.json"));
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the export location.".to_string())?;
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = write_atomic(Path::new(&path), bytes);
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result?;
        Ok(Some(path))
    }

    pub fn release_browser_download(
        file_name: &str,
        source_url: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        if file_name.is_empty()
            || file_name.len() > 120
            || file_name.starts_with('.')
            || file_name.contains(['/', '\\', '\0', '\r', '\n'])
            || source_url.is_empty()
            || source_url.len() > 2_048
        {
            return Err("The quarantined download metadata is invalid.".into());
        }
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The release panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSSavePanel::savePanel(main_thread);
        panel.setCanCreateDirectories(true);
        panel.setExtensionHidden(false);
        panel.setNameFieldStringValue(&NSString::from_str(file_name));
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the release location.".to_string())?;
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = write_quarantined_atomic(Path::new(&path), bytes, source_url);
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result?;
        Ok(Some(path))
    }

    pub fn open_workspace_archive() -> Result<Option<SelectedArchive>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The import panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setCanChooseDirectories(false);
        panel.setCanChooseFiles(true);
        panel.setAllowsMultipleSelection(false);
        panel.setResolvesAliases(true);
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the selected backup.".to_string())?;
        let path = local_path(&url)?;
        let is_codelit_archive = Path::new(&path)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("codelit"));
        if !is_codelit_archive {
            return Err("Choose a .codelit workspace backup.".into());
        }
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = (|| {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Could not inspect the selected backup: {error}"))?;
            if metadata.len() > 64 * 1024 * 1024 {
                return Err("The selected backup is larger than the 64 MB local limit.".into());
            }
            let bytes = fs::read(&path)
                .map_err(|error| format!("Could not read the selected backup: {error}"))?;
            Ok(SelectedArchive { path, bytes })
        })();
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result.map(Some)
    }

    pub fn open_skill_package() -> Result<Option<SelectedArchive>, String> {
        let main_thread = MainThreadMarker::new().ok_or_else(|| {
            "The skill import panel must be opened from the main app thread.".to_string()
        })?;
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setCanChooseDirectories(false);
        panel.setCanChooseFiles(true);
        panel.setAllowsMultipleSelection(false);
        panel.setResolvesAliases(true);
        if panel.runModal() != NSModalResponseOK {
            return Ok(None);
        }
        let url = panel
            .URL()
            .ok_or_else(|| "macOS did not return the selected skill package.".to_string())?;
        let path = local_path(&url)?;
        let extension = Path::new(&path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("codelit-skill")
            && !extension.eq_ignore_ascii_case("json")
        {
            return Err("Choose a .codelit-skill or .json skill package.".into());
        }
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let result = (|| {
            let metadata = fs::metadata(&path).map_err(|error| {
                format!("Could not inspect the selected skill package: {error}")
            })?;
            if !metadata.is_file() || metadata.len() > 256 * 1024 {
                return Err("Choose a skill package smaller than 256 KB.".into());
            }
            let bytes = fs::read(&path)
                .map_err(|error| format!("Could not read the selected skill package: {error}"))?;
            Ok(SelectedArchive { path, bytes })
        })();
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        result.map(Some)
    }

    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "The export location has an invalid file name.".to_string())?;
        let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
        let result = (|| {
            let mut file = fs::File::create(&temporary)
                .map_err(|error| format!("Could not create the workspace backup: {error}"))?;
            file.write_all(bytes)
                .map_err(|error| format!("Could not write the workspace backup: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Could not finish the workspace backup: {error}"))?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("Could not replace the workspace backup: {error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn write_quarantined_atomic(path: &Path, bytes: &[u8], source_url: &str) -> Result<(), String> {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "The release location has an invalid file name.".to_string())?;
        let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
        let result = (|| {
            let mut file = fs::File::create(&temporary)
                .map_err(|error| format!("Could not create the released file: {error}"))?;
            file.write_all(bytes)
                .map_err(|error| format!("Could not write the released file: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Could not finish the released file: {error}"))?;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Could not secure the released file: {error}"))?;
            apply_download_quarantine(&temporary, source_url)?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("Could not place the released file: {error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn apply_download_quarantine(path: &Path, source_url: &str) -> Result<(), String> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "The released file path is invalid.".to_string())?;
        let name = c"com.apple.quarantine";
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "The system clock is invalid.".to_string())?
            .as_secs();
        let safe_source = source_url.replace(';', "%3B");
        let value = format!("0081;{timestamp:x};Codelit;{safe_source}");
        let result = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if result != 0 {
            return Err("macOS could not attach its quarantine marker, so Codelit did not release the file.".into());
        }
        Ok(())
    }

    pub fn resolve_workspace_bookmark(bookmark: &[u8]) -> Result<FolderBookmark, String> {
        if bookmark.is_empty() {
            return Err("The stored folder permission is empty.".into());
        }
        let bookmark_data = NSData::with_bytes(bookmark);
        let mut is_stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &bookmark_data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut is_stale,
            )
        }
        .map_err(|error| format!("Could not restore the selected folder permission: {error}"))?;
        let was_stale = is_stale.as_bool();
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let access_validated = started && fs::read_dir(&path).is_ok();
        let refreshed_bookmark = if started && was_stale {
            create_read_only_bookmark(&url)
        } else {
            Ok(bookmark.to_vec())
        };
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }
        let refreshed_bookmark = refreshed_bookmark?;
        Ok(FolderBookmark {
            path,
            bookmark: refreshed_bookmark,
            stale: was_stale && !started,
            access_validated,
        })
    }

    pub fn with_workspace_folder_access<T>(
        bookmark: &[u8],
        action: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        if bookmark.is_empty() {
            return Err("Choose the project folder again before running local tools.".into());
        }
        let bookmark_data = NSData::with_bytes(bookmark);
        let mut is_stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &bookmark_data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut is_stale,
            )
        }
        .map_err(|_| "Choose the project folder again before running local tools.".to_string())?;
        if is_stale.as_bool() {
            return Err("The project folder permission is stale. Choose the folder again.".into());
        }
        let path = local_path(&url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        if !started {
            return Err(
                "macOS could not restore project folder access. Choose the folder again.".into(),
            );
        }
        let result = action(Path::new(&path));
        unsafe { url.stopAccessingSecurityScopedResource() };
        result
    }

    fn bookmark_for_selected_url(url: &NSURL) -> Result<FolderBookmark, String> {
        let path = local_path(url)?;
        let bookmark = create_read_only_bookmark(url)?;
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        let access_validated = started && fs::read_dir(&path).is_ok();
        if started {
            unsafe { url.stopAccessingSecurityScopedResource() };
        }

        Ok(FolderBookmark {
            path,
            bookmark,
            stale: false,
            access_validated,
        })
    }

    fn create_read_only_bookmark(url: &NSURL) -> Result<Vec<u8>, String> {
        let options = NSURLBookmarkCreationOptions::WithSecurityScope
            | NSURLBookmarkCreationOptions::SecurityScopeAllowOnlyReadAccess;
        let bookmark = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                options, None, None,
            )
            .map_err(|error| format!("Could not save the selected folder permission: {error}"))?
            .to_vec();
        Ok(bookmark)
    }

    fn local_path(url: &NSURL) -> Result<String, String> {
        url.path()
            .map(|path| path.to_string())
            .ok_or_else(|| "The selected folder does not have a local path.".to_string())
    }

    pub fn probe_background_service() -> BackgroundServiceProbe {
        let bundled = scheduler_plist_path().is_some_and(|path| path.is_file());
        let service = unsafe {
            SMAppService::agentServiceWithPlistName(&NSString::from_str(SCHEDULER_PLIST_NAME))
        };
        let status = unsafe { service.status() };
        let (status, detail) = if status == SMAppServiceStatus::Enabled {
            (
                "enabled",
                "Local schedules may run while Codelit is closed.",
            )
        } else if status == SMAppServiceStatus::RequiresApproval {
            (
                "requires-approval",
                "macOS requires approval in Login Items before local schedules can run.",
            )
        } else if status == SMAppServiceStatus::NotRegistered {
            (
                "not-registered",
                "The helper is available and remains off until the user enables local schedules.",
            )
        } else if bundled {
            (
                "not-found",
                "The helper is bundled, but registration still requires a release-signed app check.",
            )
        } else {
            (
                "not-found",
                "The scheduler helper is not present in this development bundle.",
            )
        };
        BackgroundServiceProbe {
            status: status.into(),
            bundled,
            detail: detail.into(),
        }
    }

    pub fn set_background_service_enabled(enabled: bool) -> Result<BackgroundServiceProbe, String> {
        if enabled && !scheduler_plist_path().is_some_and(|path| path.is_file()) {
            return Err(
                "The signed scheduler helper is not present in this Codelit app bundle.".into(),
            );
        }
        let service = unsafe {
            SMAppService::agentServiceWithPlistName(&NSString::from_str(SCHEDULER_PLIST_NAME))
        };
        let status = unsafe { service.status() };
        if enabled {
            if status != SMAppServiceStatus::Enabled {
                unsafe { service.registerAndReturnError() }.map_err(|error| {
                    format!("macOS could not enable local schedule background work: {error}")
                })?;
            }
        } else if status != SMAppServiceStatus::NotRegistered {
            unsafe { service.unregisterAndReturnError() }.map_err(|error| {
                format!("macOS could not disable local schedule background work: {error}")
            })?;
        }
        Ok(probe_background_service())
    }

    pub fn open_background_service_settings() {
        unsafe { SMAppService::openSystemSettingsLoginItems() };
    }

    fn scheduler_plist_path() -> Option<std::path::PathBuf> {
        let executable = std::env::current_exe().ok()?;
        let contents = executable.parent()?.parent()?;
        Some(
            contents
                .join("Library")
                .join("LaunchAgents")
                .join(SCHEDULER_PLIST_NAME),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::write_quarantined_atomic;
        use std::ffi::CString;
        use std::fs;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;

        #[test]
        fn released_browser_download_is_private_and_quarantined_before_placement() {
            let directory = tempfile::tempdir().expect("release directory");
            let path = directory.path().join("report.pdf");
            write_quarantined_atomic(
                &path,
                b"%PDF-1.7\nverified report",
                "https://example.com/report.pdf?source=a;b",
            )
            .expect("quarantined file");
            assert_eq!(
                fs::read(&path).expect("released bytes"),
                b"%PDF-1.7\nverified report"
            );
            assert_eq!(
                fs::metadata(&path)
                    .expect("released metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );

            let path = CString::new(path.as_os_str().as_bytes()).expect("release path");
            let name = c"com.apple.quarantine";
            let length = unsafe {
                libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0)
            };
            assert!(length > 0);
            let mut value = vec![0_u8; length as usize];
            let read = unsafe {
                libc::getxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            };
            assert_eq!(read, length);
            let value = String::from_utf8(value).expect("quarantine value");
            assert!(value.contains(";Codelit;https://example.com/report.pdf?source=a%3Bb"));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{
        BackgroundServiceProbe, ComputerEnvironmentInfo, DATA_KEY_BYTES, FolderBookmark,
        RunningApplicationInfo, SelectedArchive,
    };

    pub fn accessibility_permission_granted() -> bool {
        false
    }

    pub fn screen_capture_permission_granted() -> bool {
        false
    }

    pub fn request_screen_capture_permission() -> bool {
        false
    }

    pub fn computer_environment() -> Result<ComputerEnvironmentInfo, String> {
        Err("Computer use is available only on macOS.".into())
    }

    pub fn continuous_time_nanos() -> Result<u64, String> {
        Err("Computer use is available only on macOS.".into())
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("Computer use is available only on macOS.".into())
    }

    pub fn list_running_applications() -> Vec<RunningApplicationInfo> {
        Vec::new()
    }

    pub fn activate_application(_bundle_id: &str) -> Result<(), String> {
        Err("Computer use is available only on macOS.".into())
    }

    pub fn load_or_create_data_key() -> Result<[u8; DATA_KEY_BYTES], String> {
        Err("Local data encryption is available only on macOS.".into())
    }

    pub fn replace_data_key() -> Result<[u8; DATA_KEY_BYTES], String> {
        Err("Local data encryption is available only on macOS.".into())
    }

    pub fn choose_workspace_folder(
        _purpose: Option<&str>,
    ) -> Result<Option<FolderBookmark>, String> {
        Err("Local folder permissions are available only on macOS.".into())
    }

    pub fn choose_local_executable() -> Result<Option<String>, String> {
        Err("Local executable selection is available only on macOS.".into())
    }

    pub fn save_workspace_archive(_bytes: &[u8]) -> Result<Option<String>, String> {
        Err("Local workspace export is available only on macOS.".into())
    }

    pub fn save_bot_table_csv(_file_name: &str, _bytes: &[u8]) -> Result<Option<String>, String> {
        Err("Local table export is available only on macOS.".into())
    }

    pub fn save_pilot_report(_bytes: &[u8]) -> Result<Option<String>, String> {
        Err("Private product report export is available only on macOS.".into())
    }

    pub fn release_browser_download(
        _file_name: &str,
        _source_url: &str,
        _bytes: &[u8],
    ) -> Result<Option<String>, String> {
        Err("Browser download release is available only on macOS.".into())
    }

    pub fn open_workspace_archive() -> Result<Option<SelectedArchive>, String> {
        Err("Local workspace import is available only on macOS.".into())
    }

    pub fn open_skill_package() -> Result<Option<SelectedArchive>, String> {
        Err("Skill package import is available only on macOS.".into())
    }

    pub fn resolve_workspace_bookmark(_bookmark: &[u8]) -> Result<FolderBookmark, String> {
        Err("Local folder permissions are available only on macOS.".into())
    }

    pub fn with_workspace_folder_access<T>(
        _bookmark: &[u8],
        _action: impl FnOnce(&std::path::Path) -> Result<T, String>,
    ) -> Result<T, String> {
        Err("Local folder permissions are available only on macOS.".into())
    }

    pub fn probe_background_service() -> BackgroundServiceProbe {
        BackgroundServiceProbe {
            status: "unsupported".into(),
            bundled: false,
            detail: "Local schedules are available only on macOS.".into(),
        }
    }

    pub fn set_background_service_enabled(
        _enabled: bool,
    ) -> Result<BackgroundServiceProbe, String> {
        Err("Local schedules are available only on macOS.".into())
    }

    pub fn open_background_service_settings() {
        // No system settings destination exists on unsupported platforms.
    }

    pub fn store_cloud_credential(_account: &str, _value: &[u8]) -> Result<(), String> {
        Err("Codelit Cloud Keychain storage is available only on macOS.".into())
    }

    pub fn load_cloud_credential(_account: &str) -> Result<Option<Vec<u8>>, String> {
        Err("Codelit Cloud Keychain storage is available only on macOS.".into())
    }

    pub fn delete_cloud_credential(_account: &str) -> Result<(), String> {
        Err("Codelit Cloud Keychain storage is available only on macOS.".into())
    }

    pub fn open_external_https(_url: &str) -> Result<(), String> {
        Err("Opening Codelit Cloud is available only on macOS.".into())
    }
}

pub use platform::{
    accessibility_permission_granted, activate_application, choose_local_executable,
    choose_workspace_folder, computer_environment, continuous_time_nanos, delete_cloud_credential,
    list_running_applications, load_cloud_credential, load_or_create_data_key,
    open_accessibility_settings, open_background_service_settings, open_external_https,
    open_skill_package, open_workspace_archive, probe_background_service, release_browser_download,
    replace_data_key, request_screen_capture_permission, resolve_workspace_bookmark,
    save_bot_table_csv, save_pilot_report, save_workspace_archive,
    screen_capture_permission_granted, set_background_service_enabled, store_cloud_credential,
    with_workspace_folder_access,
};
