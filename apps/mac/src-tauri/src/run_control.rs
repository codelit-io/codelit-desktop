use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const POLL_INTERVAL: Duration = Duration::from_millis(40);
const TERMINATION_GRACE: Duration = Duration::from_millis(150);
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const CAPTURE_READ_BUFFER_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRunEvent {
    pub run_id: String,
    pub sequence: u64,
    pub event_type: String,
    pub provider: String,
    pub model: String,
    pub message: String,
    pub payload: Option<Value>,
    pub created_at: String,
}

type EventObserver = Arc<dyn Fn(ProviderRunEvent) + Send + Sync>;

#[derive(Clone)]
pub struct RunEventEmitter {
    run_id: String,
    provider: String,
    model: String,
    sequence: Arc<AtomicU64>,
    channel: Option<Channel<ProviderRunEvent>>,
    observer: Option<EventObserver>,
}

impl RunEventEmitter {
    pub fn new(
        run_id: impl Into<String>,
        provider: impl Into<String>,
        model: impl Into<String>,
        channel: Option<Channel<ProviderRunEvent>>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            provider: provider.into(),
            model: model.into(),
            sequence: Arc::new(AtomicU64::new(0)),
            channel,
            observer: None,
        }
    }

    #[cfg(test)]
    pub fn with_observer(mut self, observer: EventObserver) -> Self {
        self.observer = Some(observer);
        self
    }

    pub fn emit(
        &self,
        event_type: impl Into<String>,
        message: impl Into<String>,
        payload: Option<Value>,
    ) -> ProviderRunEvent {
        let event = ProviderRunEvent {
            run_id: self.run_id.clone(),
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            event_type: event_type.into(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            message: message.into(),
            payload,
            created_at: Utc::now().to_rfc3339(),
        };
        if let Some(channel) = &self.channel {
            let _ = channel.send(event.clone());
        }
        if let Some(observer) = &self.observer {
            observer(event.clone());
        }
        event
    }
}

#[derive(Clone, Default)]
pub struct RunRegistry {
    runs: Arc<Mutex<HashMap<String, RunEntry>>>,
}

struct RunEntry {
    canceled: Arc<AtomicBool>,
    active: bool,
    lifecycle: bool,
}

impl RunRegistry {
    pub fn ensure_lifecycle(&self, run_id: &str) -> Result<bool, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "The local run registry is unavailable.".to_string())?;
        if let Some(entry) = runs.get_mut(run_id) {
            entry.lifecycle = true;
            return Ok(false);
        }
        runs.insert(
            run_id.into(),
            RunEntry {
                canceled: Arc::new(AtomicBool::new(false)),
                active: false,
                lifecycle: true,
            },
        );
        Ok(true)
    }

    pub fn start_lifecycle(&self, run_id: &str) -> Result<(), String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "The local run registry is unavailable.".to_string())?;
        match runs.get_mut(run_id) {
            Some(entry) if entry.active => {
                Err("A local run with this identifier is already active.".into())
            }
            Some(entry) => {
                entry.canceled.store(false, Ordering::Release);
                entry.lifecycle = true;
                Ok(())
            }
            None => {
                runs.insert(
                    run_id.into(),
                    RunEntry {
                        canceled: Arc::new(AtomicBool::new(false)),
                        active: false,
                        lifecycle: true,
                    },
                );
                Ok(())
            }
        }
    }

    pub fn finish_lifecycle(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock()
            && let Some(entry) = runs.get_mut(run_id)
        {
            entry.lifecycle = false;
            if !entry.active {
                runs.remove(run_id);
            }
        }
    }

    pub fn begin(&self, run_id: &str) -> Result<ActiveRun, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "The local run registry is unavailable.".to_string())?;
        let entry = runs.entry(run_id.into()).or_insert_with(|| RunEntry {
            canceled: Arc::new(AtomicBool::new(false)),
            active: false,
            lifecycle: false,
        });
        if entry.active {
            return Err("A local run with this identifier is already active.".into());
        }
        entry.active = true;
        let canceled = entry.canceled.clone();
        Ok(ActiveRun {
            run_id: run_id.into(),
            canceled,
            registry: self.clone(),
        })
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        self.runs
            .lock()
            .ok()
            .and_then(|runs| runs.get(run_id).map(|entry| entry.canceled.clone()))
            .is_some_and(|canceled| {
                canceled.store(true, Ordering::Release);
                true
            })
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.runs
            .lock()
            .map(|runs| runs.values().filter(|entry| entry.active).count())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn tracked_count(&self) -> usize {
        self.runs.lock().map(|runs| runs.len()).unwrap_or(0)
    }
}

pub struct ActiveRun {
    run_id: String,
    canceled: Arc<AtomicBool>,
    registry: RunRegistry,
}

impl ActiveRun {
    pub fn token(&self) -> CancellationToken {
        CancellationToken(self.canceled.clone())
    }
}

impl Drop for ActiveRun {
    fn drop(&mut self) {
        if let Ok(mut runs) = self.registry.runs.lock()
            && let Some(entry) = runs.get_mut(&self.run_id)
            && Arc::ptr_eq(&entry.canceled, &self.canceled)
        {
            entry.active = false;
            if !entry.lifecycle {
                runs.remove(&self.run_id);
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn is_canceled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

enum CapturedLine {
    Line(OutputStream, String),
    Overflow(OutputStream),
    Done(OutputStream),
}

pub fn run_line_process<F>(
    command: Command,
    timeout: Duration,
    cancellation: &CancellationToken,
    on_line: F,
) -> Result<ProcessOutput, String>
where
    F: FnMut(OutputStream, &str),
{
    run_line_process_guarded(command, timeout, cancellation, on_line, || Ok(()))
}

pub fn run_line_process_guarded<F, G>(
    mut command: Command,
    timeout: Duration,
    cancellation: &CancellationToken,
    mut on_line: F,
    mut resource_guard: G,
) -> Result<ProcessOutput, String>
where
    F: FnMut(OutputStream, &str),
    G: FnMut() -> Result<(), String>,
{
    resource_guard()?;
    configure_process_group(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Provider stdout was unavailable.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Provider stderr was unavailable.")?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = capture_reader(stdout, OutputStream::Stdout, sender.clone());
    let stderr_thread = capture_reader(stderr, OutputStream::Stderr, sender);
    let deadline = Instant::now() + timeout;
    let mut stdout_capture = String::new();
    let mut stderr_capture = String::new();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut exit_status = None;
    let mut next_resource_check = Instant::now();

    let outcome = loop {
        if cancellation.is_canceled() {
            stop_child_tree(&mut child);
            break Err("Provider task was canceled.".into());
        }
        if Instant::now() >= deadline {
            stop_child_tree(&mut child);
            break Err("Provider task timed out and was stopped.".into());
        }
        if Instant::now() >= next_resource_check {
            if let Err(error) = resource_guard() {
                stop_child_tree(&mut child);
                break Err(error);
            }
            next_resource_check = Instant::now() + Duration::from_secs(1);
        }

        match receiver.recv_timeout(POLL_INTERVAL) {
            Ok(CapturedLine::Line(stream, line)) => {
                on_line(stream, &line);
                match stream {
                    OutputStream::Stdout => append_bounded(&mut stdout_capture, &line),
                    OutputStream::Stderr => append_bounded(&mut stderr_capture, &line),
                }
            }
            Ok(CapturedLine::Overflow(stream)) => {
                stop_child_tree(&mut child);
                let stream_name = match stream {
                    OutputStream::Stdout => "stdout",
                    OutputStream::Stderr => "stderr",
                };
                break Err(format!(
                    "Provider {stream_name} emitted a line larger than {MAX_LINE_BYTES} bytes and was stopped."
                ));
            }
            Ok(CapturedLine::Done(OutputStream::Stdout)) => stdout_done = true,
            Ok(CapturedLine::Done(OutputStream::Stderr)) => stderr_done = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stdout_done = true;
                stderr_done = true;
            }
        }

        if exit_status.is_none() {
            exit_status = child.try_wait().map_err(|error| error.to_string())?;
        }
        if let Some(status) = exit_status
            && stdout_done
            && stderr_done
        {
            break Ok(ProcessOutput {
                status,
                stdout: stdout_capture,
                stderr: stderr_capture,
            });
        }
    };

    if exit_status.is_none() {
        let _ = child.wait();
    }
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    outcome
}

pub fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub fn stop_child_tree(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    {
        let process_group = -(child.id() as i32);
        // SAFETY: the child is launched into a process group whose id equals its pid.
        unsafe {
            libc::kill(process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + TERMINATION_GRACE;
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        // SAFETY: the same dedicated child process group is still active.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn capture_reader(
    reader: impl Read + Send + 'static,
    stream: OutputStream,
    sender: mpsc::Sender<CapturedLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::with_capacity(CAPTURE_READ_BUFFER_BYTES, reader);
        let mut bytes = Vec::with_capacity(MAX_LINE_BYTES);
        while let Ok(buffer) = reader.fill_buf() {
            if buffer.is_empty() {
                break;
            }

            let consumed = if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                let segment_length = newline + 1;
                if segment_length > MAX_LINE_BYTES.saturating_sub(bytes.len()) {
                    let _ = sender.send(CapturedLine::Overflow(stream));
                    return;
                }
                bytes.extend_from_slice(&buffer[..segment_length]);
                let line = String::from_utf8_lossy(&bytes).into_owned();
                if sender.send(CapturedLine::Line(stream, line)).is_err() {
                    return;
                }
                bytes.clear();
                segment_length
            } else {
                if buffer.len() > MAX_LINE_BYTES.saturating_sub(bytes.len()) {
                    let _ = sender.send(CapturedLine::Overflow(stream));
                    return;
                }
                bytes.extend_from_slice(buffer);
                buffer.len()
            };
            reader.consume(consumed);
        }

        if !bytes.is_empty() {
            let line = String::from_utf8_lossy(&bytes).into_owned();
            if sender.send(CapturedLine::Line(stream, line)).is_err() {
                return;
            }
        }
        let _ = sender.send(CapturedLine::Done(stream));
    })
}

fn append_bounded(target: &mut String, value: &str) {
    let remaining = MAX_CAPTURE_BYTES.saturating_sub(target.len());
    if remaining == 0 {
        return;
    }
    let mut end = remaining.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&value[..end]);
}

pub fn wait_for_message(
    receiver: &Receiver<Result<String, String>>,
    deadline: Instant,
    cancellation: &CancellationToken,
    timeout_message: &str,
) -> Result<String, String> {
    loop {
        if cancellation.is_canceled() {
            return Err("Provider task was canceled.".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(timeout_message.into());
        }
        match receiver.recv_timeout(remaining.min(POLL_INTERVAL)) {
            Ok(line) => return line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("The provider output stream closed unexpectedly.".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn event_sequences_are_ordered_and_typed() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let emitter = RunEventEmitter::new("run-1", "mlx", "model-1", None).with_observer(
            Arc::new(move |event| {
                recorded.lock().expect("event lock").push(event);
            }),
        );
        emitter.emit("queued", "Queued", None);
        emitter.emit("started", "Started", None);
        emitter.emit("completed", "Done", None);

        let events = events.lock().expect("event lock");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].sequence, 1);
        assert_eq!(events[2].sequence, 3);
        assert_eq!(events[1].event_type, "started");
        assert_eq!(events[1].provider, "mlx");
    }

    #[test]
    fn duplicate_runs_are_rejected_and_drop_unregisters() {
        let registry = RunRegistry::default();
        let run = registry.begin("run-1").expect("start run");
        assert!(registry.begin("run-1").is_err());
        assert_eq!(registry.active_count(), 1);
        drop(run);
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn different_runs_are_tracked_and_canceled_independently() {
        let registry = RunRegistry::default();
        let first = registry.begin("run-first").expect("first run");
        let second = registry.begin("run-second").expect("second run");
        let first_token = first.token();
        let second_token = second.token();

        assert_eq!(registry.active_count(), 2);
        assert!(registry.cancel("run-first"));
        assert!(first_token.is_canceled());
        assert!(!second_token.is_canceled());
        assert_eq!(registry.active_count(), 2);

        drop(first);
        assert_eq!(registry.active_count(), 1);
        drop(second);
        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.tracked_count(), 0);
    }

    #[test]
    fn lifecycle_cancellation_survives_the_gap_between_native_phases() {
        let registry = RunRegistry::default();
        registry
            .start_lifecycle("run-composite")
            .expect("start lifecycle");
        let first_phase = registry.begin("run-composite").expect("first phase");
        assert!(!first_phase.token().is_canceled());
        drop(first_phase);

        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.tracked_count(), 1);
        assert!(registry.cancel("run-composite"));

        let second_phase = registry.begin("run-composite").expect("second phase");
        assert!(second_phase.token().is_canceled());
        drop(second_phase);
        assert_eq!(registry.tracked_count(), 1);

        registry.finish_lifecycle("run-composite");
        assert_eq!(registry.tracked_count(), 0);
        assert!(!registry.cancel("run-composite"));

        registry
            .start_lifecycle("run-composite")
            .expect("reuse finished run ID");
        let reused = registry.begin("run-composite").expect("reused run phase");
        assert!(!reused.token().is_canceled());
        drop(reused);
        registry.finish_lifecycle("run-composite");
        assert_eq!(registry.tracked_count(), 0);
    }

    #[test]
    fn recovered_lifecycle_does_not_reset_an_existing_cancellation() {
        let registry = RunRegistry::default();
        assert!(
            registry
                .ensure_lifecycle("run-recovered")
                .expect("recover lifecycle")
        );
        assert!(registry.cancel("run-recovered"));
        assert!(
            !registry
                .ensure_lifecycle("run-recovered")
                .expect("ensure lifecycle")
        );

        let phase = registry.begin("run-recovered").expect("recovered phase");
        assert!(phase.token().is_canceled());
        drop(phase);
        registry.finish_lifecycle("run-recovered");
        assert_eq!(registry.tracked_count(), 0);
    }

    #[test]
    fn cancellation_stops_a_bounded_process_quickly() {
        let registry = RunRegistry::default();
        let run = registry.begin("run-cancel").expect("start run");
        let token = run.token();
        let cancel_registry = registry.clone();
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            assert!(cancel_registry.cancel("run-cancel"));
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        let started = Instant::now();
        let error = run_line_process(command, Duration::from_secs(5), &token, |_, _| {})
            .expect_err("canceled process");
        cancel_thread.join().expect("cancel thread");
        assert!(error.contains("canceled"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn resource_guard_stops_a_bounded_process_quickly() {
        let registry = RunRegistry::default();
        let run = registry.begin("run-resource").expect("start run");
        let token = run.token();
        let checks = Arc::new(AtomicU64::new(0));
        let observed = checks.clone();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        let started = Instant::now();
        let error = run_line_process_guarded(
            command,
            Duration::from_secs(5),
            &token,
            |_, _| {},
            move || {
                if observed.fetch_add(1, Ordering::Relaxed) > 0 {
                    Err("Resource pressure paused this process.".into())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("resource guarded process");
        assert!(error.contains("Resource pressure"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn line_capture_is_bounded_without_breaking_utf8() {
        let mut captured = String::new();
        append_bounded(&mut captured, &"x".repeat(MAX_CAPTURE_BYTES - 1));
        append_bounded(&mut captured, "éé");
        assert!(captured.len() <= MAX_CAPTURE_BYTES);
        assert!(captured.is_char_boundary(captured.len()));
    }

    #[test]
    fn line_capture_preserves_utf8_split_across_read_buffers() {
        let expected = format!("{}é\n", "x".repeat(CAPTURE_READ_BUFFER_BYTES - 1));
        let (sender, receiver) = mpsc::channel();
        let capture = capture_reader(
            std::io::Cursor::new(expected.as_bytes().to_vec()),
            OutputStream::Stdout,
            sender,
        );

        let line = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("captured line");
        assert!(
            matches!(line, CapturedLine::Line(OutputStream::Stdout, value) if value == expected)
        );
        assert!(matches!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("capture completion"),
            CapturedLine::Done(OutputStream::Stdout)
        ));
        capture.join().expect("capture thread");
    }

    #[test]
    fn multi_megabyte_newline_free_stdout_fails_quickly() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "/usr/bin/yes x | /usr/bin/tr -d '\\n' | /usr/bin/head -c 8388608",
        ]);
        let started = Instant::now();
        let error = run_line_process(
            command,
            Duration::from_secs(5),
            &CancellationToken::default(),
            |_, _| {},
        )
        .expect_err("oversized stdout line");

        assert!(error.contains("stdout"));
        assert!(error.contains(&MAX_LINE_BYTES.to_string()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
