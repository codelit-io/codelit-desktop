// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--release-identity") {
        println!(
            "{}",
            serde_json::json!({
                "bundleIdentifier": "io.codelit.desktop",
                "version": env!("CARGO_PKG_VERSION"),
                "sourceCommit": env!("CODELIT_SOURCE_COMMIT"),
                "sourceDirty": env!("CODELIT_SOURCE_DIRTY") == "true",
            })
        );
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--release-capabilities") {
        let channel = if cfg!(feature = "app-store-release") {
            "app-store"
        } else if cfg!(feature = "direct-release") {
            "direct"
        } else {
            "development"
        };
        println!(
            "{}",
            serde_json::json!({
                "schemaVersion": 1,
                "channel": channel,
                "probes": {
                    "backgroundService": true,
                    "computerUse": !cfg!(feature = "app-store-release"),
                    "resourcePolicy": true,
                },
            })
        );
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--probe-background-service") {
        match codelit_mac_lib::background_service_probe_json() {
            Ok(probe) => println!("{probe}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--probe-resource-policy") {
        match codelit_mac_lib::resource_policy_probe_json() {
            Ok(probe) => println!("{probe}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(not(feature = "app-store-release"))]
    if std::env::args().nth(1).as_deref() == Some("--probe-computer-use") {
        match codelit_mac_lib::computer_use_readiness_json() {
            Ok(probe) => println!("{probe}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    codelit_mac_lib::run()
}
