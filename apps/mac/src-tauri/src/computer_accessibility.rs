use crate::computer_use::{ComputerAppInspection, ComputerEvidenceFrame, ComputerSemanticAction};

#[cfg(all(target_os = "macos", not(feature = "app-store-release")))]
use crate::computer_use::ComputerSemanticElement;

#[cfg(all(target_os = "macos", not(feature = "app-store-release")))]
mod platform {
    use super::{
        ComputerAppInspection, ComputerEvidenceFrame, ComputerSemanticAction,
        ComputerSemanticElement,
    };
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use core::ffi::c_void;
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFRelease, CFRetain, CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::{CFData, CFDataCreateMutable};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::geometry::CGRect;
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, HashSet};
    use std::ptr;

    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const AX_SUCCESS: AXError = 0;
    const MAX_TREE_NODES: usize = 1_000;
    const MAX_ELEMENTS: usize = 220;
    const MAX_DEPTH: usize = 12;
    const MAX_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;
    const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
    const CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
    const CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
        fn AXUIElementGetTypeID() -> usize;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> AXError;
        fn AXUIElementIsAttributeSettable(
            element: AXUIElementRef,
            attribute: CFStringRef,
            settable: *mut bool,
        ) -> AXError;
        fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> AXError;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        static CGRectNull: CGRect;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
        fn CGWindowListCreateImage(
            screen_bounds: CGRect,
            list_option: u32,
            window_id: u32,
            image_option: u32,
        ) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
    }

    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageDestinationCreateWithData(
            data: *mut c_void,
            image_type: CFStringRef,
            count: usize,
            options: *const c_void,
        ) -> *const c_void;
        fn CGImageDestinationAddImage(
            destination: *const c_void,
            image: *const c_void,
            properties: *const c_void,
        );
        fn CGImageDestinationFinalize(destination: *const c_void) -> bool;
    }

    struct OwnedAxElement(AXUIElementRef);

    impl OwnedAxElement {
        fn application(process_id: i32) -> Result<Self, String> {
            let element = unsafe { AXUIElementCreateApplication(process_id) };
            if element.is_null() {
                return Err("macOS could not inspect the approved app.".into());
            }
            unsafe {
                AXUIElementSetMessagingTimeout(element, 2.0);
            }
            Ok(Self(element))
        }

        fn retain(element: AXUIElementRef) -> Self {
            unsafe {
                CFRetain(element.cast());
            }
            Self(element)
        }
    }

    impl Drop for OwnedAxElement {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.0.cast());
            }
        }
    }

    struct Collector {
        elements: Vec<ComputerSemanticElement>,
        occurrences: HashMap<(String, String), usize>,
        visited: HashSet<usize>,
        nodes: usize,
        truncated: bool,
    }

    impl Collector {
        fn new() -> Self {
            Self {
                elements: Vec::new(),
                occurrences: HashMap::new(),
                visited: HashSet::new(),
                nodes: 0,
                truncated: false,
            }
        }

        fn walk(&mut self, element: AXUIElementRef, depth: usize) {
            if element.is_null() || !self.visited.insert(element as usize) {
                return;
            }
            self.nodes += 1;
            if self.nodes > MAX_TREE_NODES || depth > MAX_DEPTH {
                self.truncated = true;
                return;
            }
            if let Some(mut record) = describe_element(element) {
                if self.elements.len() >= MAX_ELEMENTS {
                    self.truncated = true;
                } else {
                    let key = (record.role.clone(), record.label.to_lowercase());
                    let occurrence = self.occurrences.entry(key).or_default();
                    record.occurrence = *occurrence;
                    *occurrence += 1;
                    self.elements.push(record);
                }
            }
            if self.nodes >= MAX_TREE_NODES {
                self.truncated = true;
                return;
            }
            if let Some(children) = copy_attribute(element, "AXChildren")
                .and_then(|value| value.downcast::<CFArray<*const c_void>>())
            {
                for child in children.iter() {
                    if unsafe { core_foundation::base::CFGetTypeID(*child) }
                        == unsafe { AXUIElementGetTypeID() }
                    {
                        self.walk((*child).cast(), depth + 1);
                    }
                    if self.truncated && self.elements.len() >= MAX_ELEMENTS {
                        break;
                    }
                }
            }
        }
    }

    struct SearchTarget<'a> {
        label: &'a str,
        role: Option<&'a str>,
        occurrence: usize,
    }

    struct Match {
        element: OwnedAxElement,
        record: ComputerSemanticElement,
    }

    struct Search<'a> {
        target: SearchTarget<'a>,
        occurrences: HashMap<(String, String), usize>,
        visited: HashSet<usize>,
        nodes: usize,
        found: Option<Match>,
    }

    impl Search<'_> {
        fn walk(&mut self, element: AXUIElementRef, depth: usize) {
            if self.found.is_some()
                || element.is_null()
                || depth > MAX_DEPTH
                || self.nodes >= MAX_TREE_NODES
                || !self.visited.insert(element as usize)
            {
                return;
            }
            self.nodes += 1;
            if let Some(mut record) = describe_element(element) {
                let key = (record.role.clone(), record.label.to_lowercase());
                let occurrence = self.occurrences.entry(key).or_default();
                record.occurrence = *occurrence;
                *occurrence += 1;
                let label_matches = record.label.eq_ignore_ascii_case(self.target.label);
                let role_matches = self
                    .target
                    .role
                    .is_none_or(|role| record.role.eq_ignore_ascii_case(role));
                if label_matches && role_matches && record.occurrence == self.target.occurrence {
                    self.found = Some(Match {
                        element: OwnedAxElement::retain(element),
                        record,
                    });
                    return;
                }
            }
            if let Some(children) = copy_attribute(element, "AXChildren")
                .and_then(|value| value.downcast::<CFArray<*const c_void>>())
            {
                for child in children.iter() {
                    if unsafe { core_foundation::base::CFGetTypeID(*child) }
                        == unsafe { AXUIElementGetTypeID() }
                    {
                        self.walk((*child).cast(), depth + 1);
                    }
                    if self.found.is_some() {
                        break;
                    }
                }
            }
        }
    }

    pub fn inspect(
        process_id: i32,
        bundle_id: &str,
        app_name: &str,
    ) -> Result<ComputerAppInspection, String> {
        let application = OwnedAxElement::application(process_id)?;
        let mut collector = Collector::new();
        collector.walk(application.0, 0);
        Ok(ComputerAppInspection {
            bundle_id: bundle_id.into(),
            app_name: app_name.into(),
            elements: collector.elements,
            truncated: collector.truncated,
        })
    }

    pub fn perform(process_id: i32, action: &ComputerSemanticAction) -> Result<(), String> {
        let application = OwnedAxElement::application(process_id)?;
        let (target, role, occurrence) = match action {
            ComputerSemanticAction::Press {
                target,
                role,
                occurrence,
            }
            | ComputerSemanticAction::SetValue {
                target,
                role,
                occurrence,
                ..
            } => (target.as_str(), role.as_deref(), occurrence.unwrap_or(0)),
        };
        let mut search = Search {
            target: SearchTarget {
                label: target,
                role,
                occurrence,
            },
            occurrences: HashMap::new(),
            visited: HashSet::new(),
            nodes: 0,
            found: None,
        };
        search.walk(application.0, 0);
        let matched = search.found.ok_or_else(|| {
            "That control moved or is no longer visible. Inspect the app again before retrying."
                .to_string()
        })?;
        if !matched.record.enabled {
            return Err("That control is currently disabled.".into());
        }
        match action {
            ComputerSemanticAction::Press { .. } => {
                if !matched
                    .record
                    .actions
                    .iter()
                    .any(|action| action == "press")
                {
                    return Err(
                        "That visible control does not support a semantic press action.".into(),
                    );
                }
                perform_action(matched.element.0, "AXPress")
            }
            ComputerSemanticAction::SetValue { value, .. } => {
                if matched.record.sensitive {
                    return Err(
                        "Codelit will not read or enter text in password or protected fields."
                            .into(),
                    );
                }
                if !matched
                    .record
                    .actions
                    .iter()
                    .any(|action| action == "set-value")
                {
                    return Err(
                        "That visible control does not accept text through Accessibility.".into(),
                    );
                }
                set_string_value(matched.element.0, "AXValue", value)
            }
        }
    }

    pub fn capture_window(process_id: i32, phase: &str) -> Result<ComputerEvidenceFrame, String> {
        let window_id = front_window_id(process_id)?;
        let image = unsafe {
            CGWindowListCreateImage(
                CGRectNull,
                CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
                window_id,
                CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING,
            )
        };
        if image.is_null() {
            return Err("the approved app window is not capturable".into());
        }
        let width = unsafe { CGImageGetWidth(image) };
        let height = unsafe { CGImageGetHeight(image) };
        let data_ref = unsafe { CFDataCreateMutable(ptr::null(), 0) };
        if data_ref.is_null() {
            unsafe { CFRelease(image.cast()) };
            return Err("macOS could not allocate screenshot evidence".into());
        }
        let data = unsafe { CFData::wrap_under_create_rule(data_ref.cast()) };
        let png = CFString::new("public.png");
        let destination = unsafe {
            CGImageDestinationCreateWithData(
                data.as_concrete_TypeRef() as *mut c_void,
                png.as_concrete_TypeRef(),
                1,
                ptr::null(),
            )
        };
        if destination.is_null() {
            unsafe { CFRelease(image.cast()) };
            return Err("macOS could not create PNG screenshot evidence".into());
        }
        unsafe {
            CGImageDestinationAddImage(destination, image, ptr::null());
        }
        let finalized = unsafe { CGImageDestinationFinalize(destination) };
        unsafe {
            CFRelease(destination.cast());
            CFRelease(image.cast());
        }
        if !finalized || data.is_empty() || data.len() as usize > MAX_EVIDENCE_BYTES {
            return Err("the screenshot evidence is empty or larger than 8 MB".into());
        }
        let bytes = data.bytes();
        let sha256 = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(ComputerEvidenceFrame {
            phase: phase.into(),
            mime_type: "image/png".into(),
            data_url: format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes)),
            sha256,
            window_id,
            width,
            height,
        })
    }

    fn front_window_id(process_id: i32) -> Result<u32, String> {
        let list = unsafe {
            CGWindowListCopyWindowInfo(
                CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
                0,
            )
        };
        if list.is_null() {
            return Err("macOS could not list visible app windows".into());
        }
        let windows = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(list) };
        for value in windows.iter() {
            if unsafe { core_foundation::base::CFGetTypeID(*value) }
                != CFDictionary::<*const c_void, *const c_void>::type_id()
            {
                continue;
            }
            let dictionary = unsafe {
                CFDictionary::<*const c_void, *const c_void>::wrap_under_get_rule((*value).cast())
            };
            let owner = dictionary_number(&dictionary, "kCGWindowOwnerPID");
            let layer = dictionary_number(&dictionary, "kCGWindowLayer");
            let window = dictionary_number(&dictionary, "kCGWindowNumber");
            if owner == Some(process_id as i64)
                && layer == Some(0)
                && let Some(window) = window.and_then(|value| u32::try_from(value).ok())
                && window > 0
            {
                return Ok(window);
            }
        }
        Err("the approved app has no visible window to capture".into())
    }

    fn dictionary_number(
        dictionary: &CFDictionary<*const c_void, *const c_void>,
        key: &str,
    ) -> Option<i64> {
        let key = CFString::new(key);
        let value = dictionary.find(key.as_CFTypeRef())?;
        if unsafe { core_foundation::base::CFGetTypeID(*value) } != CFNumber::type_id() {
            return None;
        }
        unsafe { CFNumber::wrap_under_get_rule((*value).cast()) }.to_i64()
    }

    fn describe_element(element: AXUIElementRef) -> Option<ComputerSemanticElement> {
        let role = copy_string(element, "AXRole")?;
        let mut sensitive = role == "AXSecureTextField"
            || copy_string(element, "AXSubrole").is_some_and(|value| value == "AXSecureTextField")
            || copy_bool(element, "AXProtectedContent").unwrap_or(false);
        let label = ["AXTitle", "AXDescription", "AXHelp", "AXIdentifier"]
            .into_iter()
            .find_map(|attribute| {
                copy_string(element, attribute).filter(|value| !value.trim().is_empty())
            })
            .or_else(|| {
                (!sensitive && matches!(role.as_str(), "AXStaticText" | "AXLink" | "AXHeading"))
                    .then(|| copy_string(element, "AXValue"))
                    .flatten()
            })?;
        let label = clean_label(&label)?;
        sensitive = sensitive || sensitive_label(&label);
        let mut actions = action_names(element);
        let text_role = matches!(
            role.as_str(),
            "AXTextField" | "AXTextArea" | "AXSearchField" | "AXComboBox"
        );
        if text_role && !sensitive && is_attribute_settable(element, "AXValue") {
            actions.push("set-value".into());
        }
        actions.sort();
        actions.dedup();
        if actions.is_empty()
            && !matches!(
                role.as_str(),
                "AXStaticText" | "AXLink" | "AXHeading" | "AXWindow" | "AXSheet"
            )
        {
            return None;
        }
        Some(ComputerSemanticElement {
            role,
            label,
            enabled: copy_bool(element, "AXEnabled").unwrap_or(true),
            actions,
            sensitive,
            occurrence: 0,
        })
    }

    fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFType> {
        let attribute = CFString::new(attribute);
        let mut value: CFTypeRef = ptr::null();
        let error = unsafe {
            AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value)
        };
        if error != AX_SUCCESS || value.is_null() {
            return None;
        }
        Some(unsafe { CFType::wrap_under_create_rule(value) })
    }

    fn copy_string(element: AXUIElementRef, attribute: &str) -> Option<String> {
        copy_attribute(element, attribute)
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
    }

    fn copy_bool(element: AXUIElementRef, attribute: &str) -> Option<bool> {
        copy_attribute(element, attribute)
            .and_then(|value| value.downcast::<CFBoolean>())
            .map(bool::from)
    }

    fn action_names(element: AXUIElementRef) -> Vec<String> {
        let mut names: CFArrayRef = ptr::null();
        let error = unsafe { AXUIElementCopyActionNames(element, &mut names) };
        if error != AX_SUCCESS || names.is_null() {
            return Vec::new();
        }
        let names = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(names) };
        names
            .iter()
            .filter_map(|value| {
                if unsafe { core_foundation::base::CFGetTypeID(*value) } != CFString::type_id() {
                    return None;
                }
                let value = unsafe { CFString::wrap_under_get_rule((*value).cast()) }.to_string();
                match value.as_str() {
                    "AXPress" => Some("press".into()),
                    "AXConfirm" => Some("confirm".into()),
                    "AXCancel" => Some("cancel".into()),
                    "AXIncrement" => Some("increment".into()),
                    "AXDecrement" => Some("decrement".into()),
                    _ => None,
                }
            })
            .collect()
    }

    fn is_attribute_settable(element: AXUIElementRef, attribute: &str) -> bool {
        let attribute = CFString::new(attribute);
        let mut settable = false;
        unsafe {
            AXUIElementIsAttributeSettable(element, attribute.as_concrete_TypeRef(), &mut settable)
                == AX_SUCCESS
                && settable
        }
    }

    fn perform_action(element: AXUIElementRef, action: &str) -> Result<(), String> {
        let action = CFString::new(action);
        let error = unsafe { AXUIElementPerformAction(element, action.as_concrete_TypeRef()) };
        if error == AX_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "macOS refused the semantic control action (Accessibility error {error})."
            ))
        }
    }

    fn set_string_value(
        element: AXUIElementRef,
        attribute: &str,
        value: &str,
    ) -> Result<(), String> {
        let attribute = CFString::new(attribute);
        let value = CFString::new(value);
        let error = unsafe {
            AXUIElementSetAttributeValue(
                element,
                attribute.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        };
        if error == AX_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "macOS refused text entry for that control (Accessibility error {error})."
            ))
        }
    }

    fn clean_label(value: &str) -> Option<String> {
        let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            return None;
        }
        Some(collapsed.chars().take(160).collect())
    }

    fn sensitive_label(value: &str) -> bool {
        let value = value.to_lowercase();
        [
            "password",
            "passcode",
            "one-time code",
            "security code",
            "api key",
            "secret key",
            "private key",
            "card number",
            "credit card",
            "social security",
            "verification code",
            "cvv",
            "cvc",
        ]
        .iter()
        .any(|needle| value.contains(needle))
    }

    #[cfg(test)]
    mod tests {
        use super::sensitive_label;

        #[test]
        fn labels_for_credentials_and_payment_secrets_fail_closed() {
            assert!(sensitive_label("Confirm password"));
            assert!(sensitive_label("API key"));
            assert!(sensitive_label("Card number"));
            assert!(!sensitive_label("Message"));
        }
    }
}

#[cfg(any(not(target_os = "macos"), feature = "app-store-release"))]
mod platform {
    use super::{ComputerAppInspection, ComputerEvidenceFrame, ComputerSemanticAction};

    pub fn inspect(
        _process_id: i32,
        _bundle_id: &str,
        _app_name: &str,
    ) -> Result<ComputerAppInspection, String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    pub fn perform(_process_id: i32, _action: &ComputerSemanticAction) -> Result<(), String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }

    pub fn capture_window(_process_id: i32, _phase: &str) -> Result<ComputerEvidenceFrame, String> {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }
}

pub use platform::{capture_window, inspect, perform};
