use crate::run_control::CancellationToken;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const OLLAMA_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 11_434);
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);
const LOCALITY_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(3);
const LOCAL_COMPLETION_CAPABILITY: &str = "completion";

#[derive(Debug, Clone, Deserialize)]
pub struct OllamaModelsResponse {
    pub models: Vec<OllamaModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub remote_model: String,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub details: OllamaModelDetails,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct OllamaModelDetails {
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub parameter_size: String,
    #[serde(default)]
    pub quantization_level: String,
}

#[derive(Debug, Deserialize)]
struct OllamaStatusResponse {
    cloud: OllamaCloudStatus,
}

#[derive(Debug, Deserialize)]
struct OllamaCloudStatus {
    disabled: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaShowResponse {
    #[serde(default)]
    remote_model: String,
    #[serde(default)]
    remote_host: String,
    #[serde(default)]
    capabilities: Vec<String>,
}

pub fn list_models(timeout: Duration) -> Result<Vec<OllamaModel>, String> {
    list_models_at(OLLAMA_ADDRESS, timeout)
}

#[allow(dead_code)] // Public integration seam; generation also enforces this internally.
pub fn preflight_local_model(model: &str, timeout: Duration) -> Result<OllamaModel, String> {
    preflight_local_model_at(OLLAMA_ADDRESS, model, timeout)
}

pub fn generate_structured<F>(
    model: &str,
    prompt: &str,
    schema: &Value,
    timeout: Duration,
    cancellation: &CancellationToken,
    on_message: F,
) -> Result<Value, String>
where
    F: FnMut(&str),
{
    generate_structured_at(
        OLLAMA_ADDRESS,
        model,
        prompt,
        schema,
        timeout,
        cancellation,
        on_message,
    )
}

fn generate_structured_at<F>(
    address: SocketAddr,
    model: &str,
    prompt: &str,
    schema: &Value,
    timeout: Duration,
    cancellation: &CancellationToken,
    mut on_message: F,
) -> Result<Value, String>
where
    F: FnMut(&str),
{
    if !address.ip().is_loopback() {
        return Err("Ollama execution is restricted to this Mac.".into());
    }
    if cancellation.is_canceled() {
        return Err("Provider task was canceled.".into());
    }
    preflight_local_model_at(address, model, timeout.min(LOCALITY_PREFLIGHT_TIMEOUT))?;
    if cancellation.is_canceled() {
        return Err("Provider task was canceled.".into());
    }
    let body = serde_json::to_vec(&json!({
        "model": model,
        "prompt": prompt,
        "format": schema,
        "stream": true,
        "think": false,
        "options": {
            "temperature": 0,
            "num_predict": 256
        }
    }))
    .map_err(|error| format!("Could not encode the Ollama request: {error}"))?;
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, timeout.min(Duration::from_secs(3)))
        .map_err(|_| "Ollama is installed but its local service is not running.".to_string())?;
    stream
        .set_read_timeout(Some(READ_POLL_INTERVAL))
        .and_then(|_| stream.set_write_timeout(Some(timeout.min(Duration::from_secs(3)))))
        .map_err(|error| format!("Could not configure the Ollama connection: {error}"))?;
    let request = format!(
        "POST /api/generate HTTP/1.1\r\nHost: 127.0.0.1:11434\r\nAccept: application/x-ndjson\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| format!("Could not send the Ollama request: {error}"))?;

    let head = read_response_head(&mut stream, deadline, cancellation)?;
    let mut generated = String::new();
    let mut line_buffer = Vec::new();
    let mut received = 0_u64;
    let mut accept_bytes = |bytes: &[u8]| -> Result<(), String> {
        received = received.saturating_add(bytes.len() as u64);
        if received > MAX_RESPONSE_BYTES {
            return Err("Ollama returned an unexpectedly large response.".into());
        }
        line_buffer.extend_from_slice(bytes);
        while let Some(newline) = line_buffer.iter().position(|byte| *byte == b'\n') {
            let line = line_buffer.drain(..=newline).collect::<Vec<_>>();
            consume_generate_line(&line, &mut generated, &mut on_message)?;
        }
        Ok(())
    };

    match head.body {
        ResponseBody::Chunked => loop {
            let size_line = read_http_line(&mut stream, deadline, cancellation, 128)?;
            let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "Ollama returned an invalid chunk size.".to_string())?;
            if size == 0 {
                break;
            }
            let chunk = read_exact_controlled(&mut stream, size, deadline, cancellation)?;
            let terminator = read_exact_controlled(&mut stream, 2, deadline, cancellation)?;
            if terminator != b"\r\n" {
                return Err("Ollama returned an invalid chunk terminator.".into());
            }
            accept_bytes(&chunk)?;
        },
        ResponseBody::ContentLength(length) => {
            if length > MAX_RESPONSE_BYTES {
                return Err("Ollama returned an unexpectedly large response.".into());
            }
            let bytes =
                read_exact_controlled(&mut stream, length as usize, deadline, cancellation)?;
            accept_bytes(&bytes)?;
        }
        ResponseBody::UntilClose => {
            let mut buffer = [0_u8; 8 * 1024];
            loop {
                match read_controlled(&mut stream, &mut buffer, deadline, cancellation)? {
                    0 => break,
                    count => accept_bytes(&buffer[..count])?,
                }
            }
        }
    }
    if !line_buffer.is_empty() {
        consume_generate_line(&line_buffer, &mut generated, &mut on_message)?;
    }
    if head.status != 200 {
        return Err(format!(
            "Ollama returned local HTTP status {}.",
            head.status
        ));
    }
    serde_json::from_str(generated.trim())
        .map_err(|error| format!("Ollama completed without valid structured output: {error}"))
}

fn consume_generate_line<F>(
    line: &[u8],
    generated: &mut String,
    on_message: &mut F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    let line = String::from_utf8_lossy(line);
    let line = line.trim();
    if line.is_empty() {
        return Ok(());
    }
    let chunk: OllamaGenerateChunk = serde_json::from_str(line)
        .map_err(|error| format!("Ollama returned an invalid stream event: {error}"))?;
    if let Some(error) = chunk.error.filter(|value| !value.trim().is_empty()) {
        return Err(error);
    }
    if has_remote_metadata(&chunk.remote_model, &chunk.remote_host) {
        return Err("Ollama attempted to route a local-only request to a remote model.".into());
    }
    if !chunk.response.is_empty() {
        generated.push_str(&chunk.response);
        on_message(&chunk.response);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct OllamaGenerateChunk {
    #[serde(default)]
    response: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    remote_model: String,
    #[serde(default)]
    remote_host: String,
}

struct ResponseHead {
    status: u16,
    body: ResponseBody,
}

enum ResponseBody {
    Chunked,
    ContentLength(u64),
    UntilClose,
}

fn read_response_head(
    stream: &mut TcpStream,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<ResponseHead, String> {
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= MAX_HEADER_BYTES {
            return Err("Ollama returned oversized HTTP headers.".into());
        }
        let byte = read_exact_controlled(stream, 1, deadline, cancellation)?;
        headers.push(byte[0]);
    }
    let headers = String::from_utf8(headers)
        .map_err(|_| "Ollama returned invalid HTTP headers.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("Ollama returned an invalid HTTP status.")?;
    let mut chunked = false;
    let mut content_length = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value.trim().eq_ignore_ascii_case("chunked")
        {
            chunked = true;
        }
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<u64>().ok();
        }
    }
    Ok(ResponseHead {
        status,
        body: if chunked {
            ResponseBody::Chunked
        } else if let Some(length) = content_length {
            ResponseBody::ContentLength(length)
        } else {
            ResponseBody::UntilClose
        },
    })
}

fn read_http_line(
    stream: &mut TcpStream,
    deadline: Instant,
    cancellation: &CancellationToken,
    limit: usize,
) -> Result<String, String> {
    let mut line = Vec::new();
    while !line.ends_with(b"\r\n") {
        if line.len() >= limit {
            return Err("Ollama returned an oversized HTTP line.".into());
        }
        let byte = read_exact_controlled(stream, 1, deadline, cancellation)?;
        line.push(byte[0]);
    }
    line.truncate(line.len().saturating_sub(2));
    String::from_utf8(line).map_err(|_| "Ollama returned an invalid HTTP line.".into())
}

fn read_exact_controlled(
    stream: &mut TcpStream,
    length: usize,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0_u8; length];
    let mut offset = 0;
    while offset < length {
        let read = read_controlled(stream, &mut bytes[offset..], deadline, cancellation)?;
        if read == 0 {
            return Err("Ollama closed the local response early.".into());
        }
        offset += read;
    }
    Ok(bytes)
}

fn read_controlled(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<usize, String> {
    loop {
        if cancellation.is_canceled() {
            return Err("Provider task was canceled.".into());
        }
        if Instant::now() >= deadline {
            return Err("Ollama structured task timed out.".into());
        }
        match stream.read(buffer) {
            Ok(read) => return Ok(read),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(format!("Could not read the Ollama response: {error}")),
        }
    }
}

fn list_models_at(address: SocketAddr, timeout: Duration) -> Result<Vec<OllamaModel>, String> {
    if !address.ip().is_loopback() {
        return Err("Ollama discovery is restricted to this Mac.".into());
    }
    let deadline = Instant::now() + timeout;
    ensure_cloud_disabled_at(address, remaining_locality_timeout(deadline)?)?;
    let models = list_model_tags_at(address, remaining_locality_timeout(deadline)?)?;
    let had_models = !models.is_empty();
    let mut verified = Vec::new();
    for model in models {
        if !is_verified_local_tag(&model) {
            continue;
        }
        let model_id = model_id(&model);
        let shown = show_model_at(address, model_id, remaining_locality_timeout(deadline)?)?;
        if is_verified_local_show(&shown) {
            verified.push(model);
        }
    }
    ensure_cloud_disabled_at(address, remaining_locality_timeout(deadline)?)?;
    if had_models && verified.is_empty() {
        return Err(
            "Ollama reported models, but none passed Codelit's local-only verification.".into(),
        );
    }
    Ok(verified)
}

fn preflight_local_model_at(
    address: SocketAddr,
    selected_model: &str,
    timeout: Duration,
) -> Result<OllamaModel, String> {
    if !address.ip().is_loopback() {
        return Err("Ollama execution is restricted to this Mac.".into());
    }
    let selected_model = selected_model.trim();
    if selected_model.is_empty()
        || selected_model.chars().count() > 180
        || is_cloud_model_name(selected_model)
    {
        return Err("The selected Ollama model is not verified as local on this Mac.".into());
    }
    let deadline = Instant::now() + timeout;
    ensure_cloud_disabled_at(address, remaining_locality_timeout(deadline)?)?;
    let model = list_model_tags_at(address, remaining_locality_timeout(deadline)?)?
        .into_iter()
        .find(|candidate| {
            candidate.name == selected_model
                || (!candidate.model.is_empty() && candidate.model == selected_model)
        })
        .filter(is_verified_local_tag)
        .ok_or("The selected Ollama model is not verified as local on this Mac.")?;
    let shown = show_model_at(
        address,
        model_id(&model),
        remaining_locality_timeout(deadline)?,
    )?;
    if !is_verified_local_show(&shown) {
        return Err("The selected Ollama model is not verified as local on this Mac.".into());
    }
    ensure_cloud_disabled_at(address, remaining_locality_timeout(deadline)?)?;
    Ok(model)
}

fn ensure_cloud_disabled_at(address: SocketAddr, timeout: Duration) -> Result<(), String> {
    if !address.ip().is_loopback() {
        return Err("Ollama locality checks are restricted to this Mac.".into());
    }
    let body = request(address, "GET", "/api/status", None, timeout)?;
    let status: OllamaStatusResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("Ollama returned an invalid local-only status: {error}"))?;
    if !status.cloud.disabled {
        return Err(
            "Disable Ollama cloud features before using Ollama as a local Codelit engine.".into(),
        );
    }
    Ok(())
}

fn list_model_tags_at(address: SocketAddr, timeout: Duration) -> Result<Vec<OllamaModel>, String> {
    if !address.ip().is_loopback() {
        return Err("Ollama discovery is restricted to this Mac.".into());
    }
    let body = request(address, "GET", "/api/tags", None, timeout)?;
    let response: OllamaModelsResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("Ollama returned an invalid model list: {error}"))?;
    Ok(response.models)
}

fn show_model_at(
    address: SocketAddr,
    model: &str,
    timeout: Duration,
) -> Result<OllamaShowResponse, String> {
    if !address.ip().is_loopback() {
        return Err("Ollama model inspection is restricted to this Mac.".into());
    }
    let body = serde_json::to_vec(&json!({ "model": model, "verbose": false }))
        .map_err(|error| format!("Could not encode the Ollama model inspection: {error}"))?;
    let response = request(address, "POST", "/api/show", Some(&body), timeout)?;
    serde_json::from_slice(&response)
        .map_err(|error| format!("Ollama returned invalid model details: {error}"))
}

fn remaining_locality_timeout(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "Ollama local-only verification timed out.".into())
}

fn model_id(model: &OllamaModel) -> &str {
    if model.model.trim().is_empty() {
        model.name.trim()
    } else {
        model.model.trim()
    }
}

fn is_verified_local_tag(model: &OllamaModel) -> bool {
    let id = model_id(model);
    let name = model.name.trim();
    !name.is_empty()
        && name.chars().count() <= 180
        && !id.is_empty()
        && id.chars().count() <= 180
        && !is_cloud_model_name(&model.name)
        && (model.model.is_empty() || !is_cloud_model_name(&model.model))
        && !has_remote_metadata(&model.remote_model, &model.remote_host)
        && model.size > 0
        && is_sha256(&model.digest)
        && (model.capabilities.is_empty() || supports_local_completion(&model.capabilities))
}

fn is_verified_local_show(model: &OllamaShowResponse) -> bool {
    !has_remote_metadata(&model.remote_model, &model.remote_host)
        && supports_local_completion(&model.capabilities)
}

fn supports_local_completion(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|capability| capability.eq_ignore_ascii_case(LOCAL_COMPLETION_CAPABILITY))
}

fn has_remote_metadata(remote_model: &str, remote_host: &str) -> bool {
    !remote_model.trim().is_empty() || !remote_host.trim().is_empty()
}

fn is_cloud_model_name(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    normalized.contains(":cloud") || normalized.contains("-cloud")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    if !address.ip().is_loopback()
        || !matches!(method, "GET" | "POST")
        || !path.starts_with("/api/")
        || path.contains(['\r', '\n'])
    {
        return Err("The local model request was rejected by policy.".into());
    }
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|_| "Ollama is installed but its local service is not running.".to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| format!("Could not configure the Ollama connection: {error}"))?;
    let body = body.unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:11434\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("Could not send the Ollama request: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read the Ollama response: {error}"))?;
    if response.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Ollama returned an unexpectedly large response.".into());
    }
    parse_http_response(&response)
}

fn parse_http_response(response: &[u8]) -> Result<Vec<u8>, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("Ollama returned an invalid HTTP response.")?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("Ollama returned an invalid HTTP status.")?;
    if status != 200 {
        return Err(format!("Ollama returned local HTTP status {status}."));
    }
    let body = &response[header_end + 4..];
    if headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        decode_chunked(body)
    } else {
        Ok(body.to_vec())
    }
}

fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("Ollama returned an invalid chunked response.")?;
        let size_text = std::str::from_utf8(&body[..line_end])
            .map_err(|_| "Ollama returned an invalid chunk size.")?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "Ollama returned an invalid chunk size.")?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if body.len() < size + 2 || &body[size..size + 2] != b"\r\n" {
            return Err("Ollama returned a truncated chunked response.".into());
        }
        decoded.extend_from_slice(&body[..size]);
        if decoded.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("Ollama returned an unexpectedly large response.".into());
        }
        body = &body[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_control::RunRegistry;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    const LOCAL_DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn json_response(body: Value) -> Vec<u8> {
        let body = serde_json::to_vec(&body).expect("encode test response");
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        response
    }

    fn status_response(disabled: bool) -> Vec<u8> {
        json_response(json!({ "cloud": { "disabled": disabled } }))
    }

    fn local_tags_response(model: &str) -> Vec<u8> {
        json_response(json!({
            "models": [{
                "name": model,
                "model": model,
                "size": 42,
                "digest": LOCAL_DIGEST,
                "details": {
                    "family": "qwen3",
                    "parameter_size": "4B",
                    "quantization_level": "Q4"
                }
            }]
        }))
    }

    fn local_show_response() -> Vec<u8> {
        json_response(json!({ "capabilities": ["completion"] }))
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set request timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            let count = stream.read(&mut buffer).expect("read test request");
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or_default();
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        request
    }

    fn request_path(request: &[u8]) -> String {
        String::from_utf8_lossy(request)
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("<invalid>")
            .to_string()
    }

    fn serve_script(
        responses: Vec<Vec<u8>>,
        observe_extra_requests_for: Duration,
    ) -> (SocketAddr, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test server");
        let address = listener.local_addr().expect("test address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept scripted request");
                let request = read_request(&mut stream);
                recorded
                    .lock()
                    .expect("request log")
                    .push(request_path(&request));
                stream
                    .write_all(&response)
                    .expect("write scripted response");
            }

            listener
                .set_nonblocking(true)
                .expect("observe extra requests");
            let deadline = Instant::now() + observe_extra_requests_for;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = read_request(&mut stream);
                        recorded
                            .lock()
                            .expect("request log")
                            .push(request_path(&request));
                        let _ = stream.write_all(
                            b"HTTP/1.1 500 Unexpected Request\r\nContent-Length: 0\r\n\r\n",
                        );
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("observe request: {error}"),
                }
            }
        });
        (address, requests, handle)
    }

    #[test]
    fn lists_only_verified_local_models_from_a_cloud_disabled_service() {
        let (address, requests, server) = serve_script(
            vec![
                status_response(true),
                local_tags_response("qwen3:4b"),
                local_show_response(),
                status_response(true),
            ],
            Duration::ZERO,
        );
        let models = list_models_at(address, Duration::from_secs(1)).expect("model list");
        server.join().expect("test server");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "qwen3:4b");
        assert_eq!(
            *requests.lock().expect("request log"),
            ["/api/status", "/api/tags", "/api/show", "/api/status"]
        );
    }

    #[test]
    fn filters_cloud_named_and_remote_tags_before_model_inspection() {
        let tags = json_response(json!({
            "models": [
                {
                    "name": "qwen3:4b",
                    "model": "qwen3:4b",
                    "size": 42,
                    "digest": LOCAL_DIGEST
                },
                {
                    "name": "gpt-oss:120b-cloud",
                    "model": "gpt-oss:120b-cloud",
                    "size": 42,
                    "digest": LOCAL_DIGEST
                },
                {
                    "name": "neutral-alias",
                    "model": "neutral-alias",
                    "remote_model": "provider/model",
                    "remote_host": "https://example.invalid",
                    "size": 42,
                    "digest": LOCAL_DIGEST
                }
            ]
        }));
        let (address, requests, server) = serve_script(
            vec![
                status_response(true),
                tags,
                local_show_response(),
                status_response(true),
            ],
            Duration::ZERO,
        );
        let models = list_models_at(address, Duration::from_secs(1)).expect("model list");
        server.join().expect("test server");
        assert_eq!(
            models
                .iter()
                .map(|model| model.name.as_str())
                .collect::<Vec<_>>(),
            ["qwen3:4b"]
        );
        assert_eq!(
            *requests.lock().expect("request log"),
            ["/api/status", "/api/tags", "/api/show", "/api/status"]
        );
    }

    #[test]
    fn decodes_chunked_local_responses() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Transfer-Encoding: chunked\r\n",
            "\r\n",
            "8\r\n",
            "{\"models\r\n",
            "5\r\n",
            "\":[]}\r\n",
            "0\r\n",
            "\r\n"
        )
        .as_bytes()
        .to_vec();
        let (address, _, server) = serve_script(vec![response], Duration::ZERO);
        let response = request(address, "GET", "/api/tags", None, Duration::from_secs(1))
            .expect("chunked response");
        server.join().expect("test server");
        let models: OllamaModelsResponse =
            serde_json::from_slice(&response).expect("models response");
        assert!(models.models.is_empty());
    }

    #[test]
    fn rejects_cloud_names_invalid_local_artifacts_and_remote_metadata() {
        let valid = OllamaModel {
            name: "qwen3:4b".into(),
            model: "qwen3:4b".into(),
            remote_model: String::new(),
            remote_host: String::new(),
            size: 42,
            digest: LOCAL_DIGEST.into(),
            details: OllamaModelDetails::default(),
            capabilities: Vec::new(),
        };
        assert!(is_verified_local_tag(&valid));
        for name in ["qwen3:cloud", "qwen3:4b-cloud"] {
            let mut model = valid.clone();
            model.name = name.into();
            model.model = name.into();
            assert!(!is_verified_local_tag(&model));
        }
        let mut invalid_digest = valid.clone();
        invalid_digest.digest = "not-a-local-digest".into();
        assert!(!is_verified_local_tag(&invalid_digest));
        let mut zero_size = valid.clone();
        zero_size.size = 0;
        assert!(!is_verified_local_tag(&zero_size));
        let mut unsupported = valid.clone();
        unsupported.capabilities = vec!["embedding".into()];
        assert!(!is_verified_local_tag(&unsupported));
        let mut remote = valid;
        remote.remote_host = "https://example.invalid".into();
        assert!(!is_verified_local_tag(&remote));
        assert!(!is_verified_local_show(&OllamaShowResponse {
            remote_model: "provider/model".into(),
            remote_host: String::new(),
            capabilities: vec!["completion".into()],
        }));
        assert!(!is_verified_local_show(&OllamaShowResponse {
            remote_model: String::new(),
            remote_host: String::new(),
            capabilities: vec!["embedding".into()],
        }));
    }

    #[test]
    fn rejects_non_loopback_destinations() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 11_434);
        assert!(list_models_at(address, Duration::from_millis(1)).is_err());
    }

    #[test]
    fn cloud_named_models_fail_before_any_local_request() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 9);
        let registry = RunRegistry::default();
        for (run_id, model) in [
            ("ollama-cloud-name-colon", "qwen3:cloud"),
            ("ollama-cloud-name-dash", "qwen3:4b-cloud"),
        ] {
            let run = registry.begin(run_id).expect("start run");
            let error = generate_structured_at(
                address,
                model,
                "secret prompt",
                &json!({"type":"object"}),
                Duration::from_millis(100),
                &run.token(),
                |_| {},
            )
            .expect_err("cloud model name must be rejected before connecting");
            assert!(error.contains("not verified as local"));
        }
    }

    #[test]
    fn streams_structured_generation_from_the_loopback_service() {
        let lines = concat!(
            "{\"response\":\"{\\\"summary\\\":\\\"local\",\"done\":false}\n",
            "{\"response\":\" ready\\\",\\\"items\\\":[\\\"offline\\\"]}\",\"done\":false}\n",
            "{\"response\":\"\",\"done\":true}\n"
        );
        let generation_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            lines.len(),
            lines
        )
        .into_bytes();
        let (address, requests, server) = serve_script(
            vec![
                status_response(true),
                local_tags_response("qwen3:4b"),
                local_show_response(),
                status_response(true),
                generation_response,
            ],
            Duration::ZERO,
        );
        let registry = RunRegistry::default();
        let run = registry.begin("ollama-stream").expect("start run");
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let recorded = chunks.clone();
        let value = generate_structured_at(
            address,
            "qwen3:4b",
            "health check",
            &json!({"type":"object"}),
            Duration::from_secs(2),
            &run.token(),
            move |chunk| recorded.lock().expect("chunk lock").push(chunk.to_string()),
        )
        .expect("structured output");
        server.join().expect("test server");
        assert_eq!(value["summary"], "local ready");
        assert_eq!(chunks.lock().expect("chunk lock").len(), 2);
        assert_eq!(
            *requests.lock().expect("request log"),
            [
                "/api/status",
                "/api/tags",
                "/api/show",
                "/api/status",
                "/api/generate"
            ]
        );
    }

    #[test]
    fn cloud_enabled_status_fails_before_prompt_is_sent() {
        let (address, requests, server) =
            serve_script(vec![status_response(false)], Duration::from_millis(150));
        let registry = RunRegistry::default();
        let run = registry.begin("ollama-cloud-enabled").expect("start run");
        let error = generate_structured_at(
            address,
            "qwen3:4b",
            "secret prompt",
            &json!({"type":"object"}),
            Duration::from_secs(1),
            &run.token(),
            |_| {},
        )
        .expect_err("cloud-enabled daemon must fail closed");
        server.join().expect("test server");
        assert!(error.contains("Disable Ollama cloud"));
        assert_eq!(*requests.lock().expect("request log"), ["/api/status"]);
    }

    #[test]
    fn remote_show_metadata_fails_before_prompt_is_sent() {
        let remote_show = json_response(json!({
            "remote_model": "provider/model",
            "remote_host": "https://example.invalid",
            "capabilities": ["completion"]
        }));
        let (address, requests, server) = serve_script(
            vec![
                status_response(true),
                local_tags_response("neutral-alias"),
                remote_show,
            ],
            Duration::from_millis(150),
        );
        let registry = RunRegistry::default();
        let run = registry.begin("ollama-remote-show").expect("start run");
        let error = generate_structured_at(
            address,
            "neutral-alias",
            "secret prompt",
            &json!({"type":"object"}),
            Duration::from_secs(1),
            &run.token(),
            |_| {},
        )
        .expect_err("remote model inspection must fail closed");
        server.join().expect("test server");
        assert!(error.contains("not verified as local"));
        assert_eq!(
            *requests.lock().expect("request log"),
            ["/api/status", "/api/tags", "/api/show"]
        );
    }

    #[test]
    fn cloud_status_flip_after_model_validation_fails_before_prompt_is_sent() {
        let (address, requests, server) = serve_script(
            vec![
                status_response(true),
                local_tags_response("qwen3:4b"),
                local_show_response(),
                status_response(false),
            ],
            Duration::from_millis(150),
        );
        let registry = RunRegistry::default();
        let run = registry.begin("ollama-status-flip").expect("start run");
        let error = generate_structured_at(
            address,
            "qwen3:4b",
            "secret prompt",
            &json!({"type":"object"}),
            Duration::from_secs(1),
            &run.token(),
            |_| {},
        )
        .expect_err("cloud status flip must fail closed");
        server.join().expect("test server");
        assert!(error.contains("Disable Ollama cloud"));
        assert_eq!(
            *requests.lock().expect("request log"),
            ["/api/status", "/api/tags", "/api/show", "/api/status"]
        );
    }

    #[test]
    fn generation_can_be_canceled_while_the_service_is_idle() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test server");
        let address = listener.local_addr().expect("test address");
        thread::spawn(move || {
            for response in [
                status_response(true),
                local_tags_response("qwen3:4b"),
                local_show_response(),
                status_response(true),
            ] {
                let (mut stream, _) = listener.accept().expect("accept preflight request");
                let _ = read_request(&mut stream);
                stream
                    .write_all(&response)
                    .expect("write preflight response");
            }
            let (mut stream, _) = listener.accept().expect("accept generation request");
            let _ = read_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .expect("write headers");
            thread::sleep(Duration::from_secs(2));
        });
        let registry = RunRegistry::default();
        let run = registry.begin("ollama-cancel").expect("start run");
        let cancel_registry = registry.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancel_registry.cancel("ollama-cancel");
        });
        let started = Instant::now();
        let error = generate_structured_at(
            address,
            "qwen3:4b",
            "health check",
            &json!({"type":"object"}),
            Duration::from_secs(5),
            &run.token(),
            |_| {},
        )
        .expect_err("canceled generation");
        assert!(error.contains("canceled"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
