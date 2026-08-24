use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThermalState {
    Nominal,
    Fair,
    Serious,
    Critical,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResourceState {
    thermal: ThermalState,
    low_power_mode: bool,
    available_memory_bytes: u64,
}

const ONE_GIB: u64 = 1024 * 1024 * 1024;
const CRITICAL_AVAILABLE_MEMORY_BYTES: u64 = 2 * ONE_GIB;
const CONSTRAINED_AVAILABLE_MEMORY_BYTES: u64 = 6 * ONE_GIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BackgroundRunCapacity {
    pub max_parallel: u8,
    pub detail: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MlxOperation {
    Download,
    Benchmark,
    Inference,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePolicyProbe {
    schema_version: u8,
    bundle_identifier: &'static str,
    version: &'static str,
    channel: &'static str,
    source_commit: &'static str,
    source_dirty: bool,
    executable_sha256: String,
    live: ResourcePolicyLiveState,
    matrix: Vec<ResourcePolicyCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePolicyLiveState {
    thermal_state: &'static str,
    low_power_mode: bool,
    available_memory_known: bool,
    available_memory_bytes: u64,
    max_parallel: u8,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ResourcePolicyCase {
    id: &'static str,
    thermal_state: &'static str,
    low_power_mode: bool,
    available_memory_bytes: u64,
    mlx_download: &'static str,
    mlx_benchmark: &'static str,
    mlx_inference: &'static str,
    max_parallel: u8,
}

pub fn ensure_mlx_allowed(operation: MlxOperation) -> Result<(), String> {
    resource_issue(current_resource_state(), operation).map_or(Ok(()), Err)
}

pub fn resource_policy_probe_json() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Codelit could not locate its executable: {error}"))?;
    let live = current_resource_state();
    let live_capacity = background_run_capacity_for(live);
    let probe = ResourcePolicyProbe {
        schema_version: 1,
        bundle_identifier: "io.codelit.desktop",
        version: env!("CARGO_PKG_VERSION"),
        channel: release_channel(),
        source_commit: env!("CODELIT_SOURCE_COMMIT"),
        source_dirty: env!("CODELIT_SOURCE_DIRTY") == "true",
        executable_sha256: sha256_file(&executable)?,
        live: ResourcePolicyLiveState {
            thermal_state: thermal_state_name(live.thermal),
            low_power_mode: live.low_power_mode,
            available_memory_known: live.available_memory_bytes > 0,
            available_memory_bytes: live.available_memory_bytes,
            max_parallel: live_capacity.max_parallel,
        },
        matrix: resource_policy_matrix(),
    };
    serde_json::to_string(&probe).map_err(|error| error.to_string())
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Codelit could not read its executable: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|error| format!("Codelit could not hash its executable: {error}"))?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(not(test))]
pub(crate) fn background_run_capacity() -> BackgroundRunCapacity {
    background_run_capacity_for(current_resource_state())
}

#[cfg(test)]
pub(crate) fn healthy_background_run_capacity_for_test() -> BackgroundRunCapacity {
    BackgroundRunCapacity {
        max_parallel: 2,
        detail: "Waiting for one active specialist to finish.",
    }
}

fn background_run_capacity_for(state: ResourceState) -> BackgroundRunCapacity {
    if matches!(
        state.thermal,
        ThermalState::Serious | ThermalState::Critical
    ) {
        return BackgroundRunCapacity {
            max_parallel: 0,
            detail: "Waiting for this Mac to cool before starting another specialist.",
        };
    }
    if state.available_memory_bytes > 0
        && state.available_memory_bytes < CRITICAL_AVAILABLE_MEMORY_BYTES
    {
        return BackgroundRunCapacity {
            max_parallel: 0,
            detail: "Waiting for more memory before starting another specialist.",
        };
    }
    if state.low_power_mode
        || state.thermal == ThermalState::Fair
        || (state.available_memory_bytes > 0
            && state.available_memory_bytes < CONSTRAINED_AVAILABLE_MEMORY_BYTES)
    {
        return BackgroundRunCapacity {
            max_parallel: 1,
            detail: "Running one specialist at a time while this Mac has less capacity.",
        };
    }
    BackgroundRunCapacity {
        max_parallel: 2,
        detail: "Waiting for one active specialist to finish.",
    }
}

fn resource_issue(state: ResourceState, operation: MlxOperation) -> Option<String> {
    if matches!(
        state.thermal,
        ThermalState::Serious | ThermalState::Critical
    ) {
        return Some(
            "The on-device model paused because this Mac is under thermal pressure. Let it cool, then retry."
                .into(),
        );
    }
    if state.low_power_mode && matches!(operation, MlxOperation::Download | MlxOperation::Benchmark)
    {
        return Some(
            "The on-device model paused while Low Power Mode is enabled. Turn it off to finish this model setup."
                .into(),
        );
    }
    None
}

fn release_channel() -> &'static str {
    if cfg!(feature = "app-store-release") {
        "app-store"
    } else if cfg!(feature = "direct-release") {
        "direct"
    } else {
        "development"
    }
}

fn thermal_state_name(state: ThermalState) -> &'static str {
    match state {
        ThermalState::Nominal => "nominal",
        ThermalState::Fair => "fair",
        ThermalState::Serious => "serious",
        ThermalState::Critical => "critical",
        ThermalState::Unknown => "unknown",
    }
}

fn operation_state(state: ResourceState, operation: MlxOperation) -> &'static str {
    if resource_issue(state, operation).is_some() {
        "blocked"
    } else {
        "allowed"
    }
}

fn resource_policy_case(id: &'static str, state: ResourceState) -> ResourcePolicyCase {
    ResourcePolicyCase {
        id,
        thermal_state: thermal_state_name(state.thermal),
        low_power_mode: state.low_power_mode,
        available_memory_bytes: state.available_memory_bytes,
        mlx_download: operation_state(state, MlxOperation::Download),
        mlx_benchmark: operation_state(state, MlxOperation::Benchmark),
        mlx_inference: operation_state(state, MlxOperation::Inference),
        max_parallel: background_run_capacity_for(state).max_parallel,
    }
}

fn resource_policy_matrix() -> Vec<ResourcePolicyCase> {
    vec![
        resource_policy_case(
            "nominal",
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "fair",
            ResourceState {
                thermal: ThermalState::Fair,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "low-power",
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: true,
                available_memory_bytes: 12 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "serious",
            ResourceState {
                thermal: ThermalState::Serious,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "critical",
            ResourceState {
                thermal: ThermalState::Critical,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "constrained-memory",
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: 4 * ONE_GIB,
            },
        ),
        resource_policy_case(
            "critical-memory",
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: ONE_GIB,
            },
        ),
    ]
}

#[cfg(target_os = "macos")]
fn current_resource_state() -> ResourceState {
    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};

    unsafe extern "C" {
        fn os_proc_available_memory() -> usize;
    }

    let process = NSProcessInfo::processInfo();
    let thermal = match process.thermalState() {
        NSProcessInfoThermalState::Nominal => ThermalState::Nominal,
        NSProcessInfoThermalState::Fair => ThermalState::Fair,
        NSProcessInfoThermalState::Serious => ThermalState::Serious,
        NSProcessInfoThermalState::Critical => ThermalState::Critical,
        _ => ThermalState::Unknown,
    };
    ResourceState {
        thermal,
        low_power_mode: process.isLowPowerModeEnabled(),
        available_memory_bytes: unsafe { os_proc_available_memory() as u64 },
    }
}

#[cfg(not(target_os = "macos"))]
fn current_resource_state() -> ResourceState {
    ResourceState {
        thermal: ThermalState::Unknown,
        low_power_mode: false,
        available_memory_bytes: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thermal_pressure_stops_every_mlx_operation() {
        for thermal in [ThermalState::Serious, ThermalState::Critical] {
            for operation in [
                MlxOperation::Download,
                MlxOperation::Benchmark,
                MlxOperation::Inference,
            ] {
                let issue = resource_issue(
                    ResourceState {
                        thermal,
                        low_power_mode: false,
                        available_memory_bytes: 12 * ONE_GIB,
                    },
                    operation,
                )
                .expect("thermal issue");
                assert!(issue.contains("thermal pressure"));
            }
        }
    }

    #[test]
    fn low_power_mode_pauses_setup_but_keeps_bounded_inference_available() {
        let state = ResourceState {
            thermal: ThermalState::Nominal,
            low_power_mode: true,
            available_memory_bytes: 12 * ONE_GIB,
        };
        assert!(resource_issue(state, MlxOperation::Download).is_some());
        assert!(resource_issue(state, MlxOperation::Benchmark).is_some());
        assert_eq!(resource_issue(state, MlxOperation::Inference), None);
    }

    #[test]
    fn nominal_and_fair_states_allow_inference() {
        for thermal in [
            ThermalState::Nominal,
            ThermalState::Fair,
            ThermalState::Unknown,
        ] {
            assert_eq!(
                resource_issue(
                    ResourceState {
                        thermal,
                        low_power_mode: false,
                        available_memory_bytes: 12 * ONE_GIB,
                    },
                    MlxOperation::Inference,
                ),
                None
            );
        }
    }

    #[test]
    fn healthy_devices_keep_two_background_lanes() {
        assert_eq!(
            background_run_capacity_for(ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            })
            .max_parallel,
            2
        );
    }

    #[test]
    fn fair_thermal_low_power_or_constrained_memory_reduce_to_one_lane() {
        for state in [
            ResourceState {
                thermal: ThermalState::Fair,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: true,
                available_memory_bytes: 12 * ONE_GIB,
            },
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: 4 * ONE_GIB,
            },
        ] {
            assert_eq!(background_run_capacity_for(state).max_parallel, 1);
        }
    }

    #[test]
    fn serious_thermal_or_critical_memory_pause_new_background_work() {
        for state in [
            ResourceState {
                thermal: ThermalState::Serious,
                low_power_mode: false,
                available_memory_bytes: 12 * ONE_GIB,
            },
            ResourceState {
                thermal: ThermalState::Nominal,
                low_power_mode: false,
                available_memory_bytes: ONE_GIB,
            },
        ] {
            assert_eq!(background_run_capacity_for(state).max_parallel, 0);
        }
    }

    #[test]
    fn resource_probe_exercises_every_compiled_backpressure_boundary() {
        let matrix = resource_policy_matrix();
        assert_eq!(matrix.len(), 7);
        assert_eq!(
            matrix
                .iter()
                .map(|case| (case.id, case.max_parallel))
                .collect::<Vec<_>>(),
            vec![
                ("nominal", 2),
                ("fair", 1),
                ("low-power", 1),
                ("serious", 0),
                ("critical", 0),
                ("constrained-memory", 1),
                ("critical-memory", 0),
            ]
        );
        let low_power = matrix
            .iter()
            .find(|case| case.id == "low-power")
            .expect("low power case");
        assert_eq!(low_power.mlx_download, "blocked");
        assert_eq!(low_power.mlx_benchmark, "blocked");
        assert_eq!(low_power.mlx_inference, "allowed");
        for id in ["serious", "critical"] {
            let pressured = matrix
                .iter()
                .find(|case| case.id == id)
                .expect("thermal pressure case");
            assert_eq!(pressured.mlx_download, "blocked");
            assert_eq!(pressured.mlx_benchmark, "blocked");
            assert_eq!(pressured.mlx_inference, "blocked");
        }
    }
}
