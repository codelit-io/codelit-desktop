use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const LM_STUDIO_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1_234);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAMED_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_SSE_LINE_BYTES: usize = 256 * 1024;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_MODEL_ID_CHARS: usize = 240;
const MAX_MODELS: usize = 512;
const MAX_MODEL_BYTES: u64 = 16 * 1024 * 1024 * 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 2_800;
const MAX_ITEMS: usize = 3;
const MAX_ITEM_BYTES: usize = 350;
const MAX_FORMATTED_OUTPUT_BYTES: usize = 4_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmStudioModel {
    pub id: String,
    pub label: String,
    pub publisher: String,
    pub format: String,
    pub size_bytes: u64,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    models: Vec<ApiModel>,
}

#[derive(Debug, Deserialize)]
struct ApiModel {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    publisher: String,
    key: String,
    display_name: String,
    #[serde(default)]
    architecture: Option<String>,
    #[serde(default)]
    quantization: Option<ApiQuantization>,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default)]
    params_string: Option<String>,
    #[serde(default)]
    loaded_instances: Vec<LoadedInstance>,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiQuantization {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadedInstance {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ChatChunk {
    #[serde(default)]
    choices: Vec<ChatChoice>,
    #[serde(default)]
    error: Option<ChatError>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    delta: ChatDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChatError {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StrictOutput {
    summary: String,
    items: Vec<String>,
}

pub fn list_models(timeout: Duration) -> Result<Vec<LmStudioModel>, String> {
    list_models_at(LM_STUDIO_ADDRESS, timeout, &|| false)
}

#[allow(dead_code)] // Public integration seam; generation also preflights internally.
pub fn preflight_model(model: &str, timeout: Duration) -> Result<LmStudioModel, String> {
    preflight_model_at(LM_STUDIO_ADDRESS, model, timeout, &|| false)
}

pub fn generate_structured<C, F>(
    model: &str,
    prompt: &str,
    timeout: Duration,
    is_canceled: C,
    on_message: F,
) -> Result<Value, String>
where
    C: Fn() -> bool,
    F: FnMut(&str),
{
    generate_structured_at(
        LM_STUDIO_ADDRESS,
        model,
        prompt,
        timeout,
        &is_canceled,
        on_message,
    )
}

fn list_models_at<C>(
    address: SocketAddr,
    timeout: Duration,
    is_canceled: &C,
) -> Result<Vec<LmStudioModel>, String>
where
    C: Fn() -> bool,
{
    ensure_fixed_loopback(address)?;
    let deadline = deadline_after(timeout)?;
    let body = request_body_at(address, Endpoint::Models, None, deadline, is_canceled)?;
    let response: ModelsResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("LM Studio returned an invalid v1 model list: {error}"))?;
    if response.models.len() > MAX_MODELS {
        return Err("LM Studio returned too many models for a bounded local probe.".into());
    }
    Ok(response
        .models
        .into_iter()
        .filter_map(valid_local_completion_model)
        .collect())
}

fn preflight_model_at<C>(
    address: SocketAddr,
    selected_model: &str,
    timeout: Duration,
    is_canceled: &C,
) -> Result<LmStudioModel, String>
where
    C: Fn() -> bool,
{
    ensure_fixed_loopback(address)?;
    let selected_model = selected_model.trim();
    if !is_safe_model_id(selected_model) {
        return Err(
            "The selected LM Studio model is not a verified local model on this Mac.".into(),
        );
    }
    list_models_at(address, timeout, is_canceled)?
        .into_iter()
        .find(|model| model.id == selected_model)
        .ok_or_else(|| {
            "The selected LM Studio model is not a completion-capable local model on this Mac."
                .into()
        })
}

fn generate_structured_at<C, F>(
    address: SocketAddr,
    model: &str,
    prompt: &str,
    timeout: Duration,
    is_canceled: &C,
    mut on_message: F,
) -> Result<Value, String>
where
    C: Fn() -> bool,
    F: FnMut(&str),
{
    ensure_fixed_loopback(address)?;
    if is_canceled() {
        return Err("Provider task was canceled.".into());
    }
    if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
        return Err("The LM Studio prompt is empty or exceeds the local request limit.".into());
    }
    let deadline = deadline_after(timeout)?;
    preflight_model_at(address, model, remaining_timeout(deadline)?, is_canceled)?;
    if is_canceled() {
        return Err("Provider task was canceled.".into());
    }

    let body = serde_json::to_vec(&json!({
        "model": model.trim(),
        "messages": [
            {
                "role": "system",
                "content": "Return only the requested JSON. Do not call tools, use MCP, access URLs, or retain session state."
            },
            { "role": "user", "content": prompt }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "codelit_local_summary",
                "strict": true,
                "schema": output_schema()
            }
        },
        "temperature": 0,
        "max_tokens": 512,
        "stream": true
    }))
    .map_err(|error| format!("Could not encode the LM Studio request: {error}"))?;
    let (mut stream, head) = open_request_at(
        address,
        Endpoint::ChatCompletions,
        Some(&body),
        deadline,
        is_canceled,
    )?;
    ensure_success_status(head.status, Endpoint::ChatCompletions)?;

    let mut state = SseState::default();
    read_response_body(
        &mut stream,
        head.body,
        deadline,
        is_canceled,
        MAX_HTTP_BODY_BYTES,
        |bytes| state.push(bytes, &mut on_message),
    )?;
    state.finish(&mut on_message)?;
    validate_structured_output(&state.generated)
}

fn output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_SUMMARY_BYTES
            },
            "items": {
                "type": "array",
                "maxItems": MAX_ITEMS,
                "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_ITEM_BYTES
                }
            }
        },
        "required": ["summary", "items"]
    })
}

fn valid_local_completion_model(model: ApiModel) -> Option<LmStudioModel> {
    let key = model.key.trim();
    let format = model.format.as_deref()?.trim().to_ascii_lowercase();
    let architecture = model.architecture.as_deref()?.trim();
    let label = model.display_name.trim();
    let publisher = model.publisher.trim();
    let instances_are_local = model
        .loaded_instances
        .iter()
        .all(|instance| !contains_remote_url(&instance.id));
    if !model.kind.eq_ignore_ascii_case("llm")
        || !is_safe_model_id(key)
        || label.is_empty()
        || label.chars().count() > 240
        || publisher.chars().count() > 160
        || architecture.is_empty()
        || architecture.chars().count() > 80
        || !matches!(format.as_str(), "gguf" | "mlx")
        || model.size_bytes == 0
        || model.size_bytes > MAX_MODEL_BYTES
        || contains_remote_url(label)
        || contains_remote_url(publisher)
        || contains_remote_url(architecture)
        || !instances_are_local
    {
        return None;
    }
    let parameter_size = bounded_optional(model.params_string, 80)?;
    let quantization = match model.quantization {
        Some(quantization) => bounded_optional(quantization.name, 80)?,
        None => None,
    };
    Some(LmStudioModel {
        id: key.to_string(),
        label: label.to_string(),
        publisher: publisher.to_string(),
        format,
        size_bytes: model.size_bytes,
        parameter_size,
        quantization,
    })
}

fn bounded_optional(value: Option<String>, max_chars: usize) -> Option<Option<String>> {
    match value {
        Some(value) => {
            let value = value.trim();
            if value.chars().count() > max_chars || contains_remote_url(value) {
                None
            } else if value.is_empty() {
                Some(None)
            } else {
                Some(Some(value.to_string()))
            }
        }
        None => Some(None),
    }
}

fn is_safe_model_id(model: &str) -> bool {
    let model = model.trim();
    !model.is_empty()
        && model.chars().count() <= MAX_MODEL_ID_CHARS
        && !contains_remote_url(model)
        && !model.starts_with('/')
        && !model.contains(['\\', '?', '#'])
        && !model
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
        && model.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '/' | '@' | '+')
        })
}

fn contains_remote_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("//")
        || ["http://", "https://", "ws://", "wss://", "file://"]
            .iter()
            .any(|scheme| normalized.contains(scheme))
}

fn validate_structured_output(content: &str) -> Result<Value, String> {
    let output: StrictOutput = serde_json::from_str(content.trim())
        .map_err(|error| format!("LM Studio returned invalid structured output: {error}"))?;
    let summary = output.summary.trim();
    if summary.is_empty() || output.summary.len() > MAX_SUMMARY_BYTES {
        return Err("LM Studio returned a summary outside the local output limits.".into());
    }
    if output.items.len() > MAX_ITEMS {
        return Err("LM Studio returned too many structured items.".into());
    }
    let mut formatted_bytes = summary.len();
    for item in &output.items {
        let item = item.trim();
        if item.is_empty() || item.len() > MAX_ITEM_BYTES {
            return Err("LM Studio returned an invalid structured item.".into());
        }
        formatted_bytes = formatted_bytes.saturating_add(3 + item.len());
    }
    if formatted_bytes > MAX_FORMATTED_OUTPUT_BYTES {
        return Err("LM Studio returned structured output above the local display limit.".into());
    }
    serde_json::to_value(output)
        .map_err(|error| format!("Could not normalize the LM Studio output: {error}"))
}

#[derive(Clone, Copy)]
enum Endpoint {
    Models,
    ChatCompletions,
}

impl Endpoint {
    fn method(self) -> &'static str {
        match self {
            Self::Models => "GET",
            Self::ChatCompletions => "POST",
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Models => "/api/v1/models",
            Self::ChatCompletions => "/v1/chat/completions",
        }
    }

    fn accept(self) -> &'static str {
        match self {
            Self::Models => "application/json",
            Self::ChatCompletions => "text/event-stream",
        }
    }
}

fn request_body_at<C>(
    address: SocketAddr,
    endpoint: Endpoint,
    body: Option<&[u8]>,
    deadline: Instant,
    is_canceled: &C,
) -> Result<Vec<u8>, String>
where
    C: Fn() -> bool,
{
    let (mut stream, head) = open_request_at(address, endpoint, body, deadline, is_canceled)?;
    ensure_success_status(head.status, endpoint)?;
    let mut response = Vec::new();
    read_response_body(
        &mut stream,
        head.body,
        deadline,
        is_canceled,
        MAX_HTTP_BODY_BYTES,
        |bytes| {
            response.extend_from_slice(bytes);
            Ok(())
        },
    )?;
    Ok(response)
}

fn open_request_at<C>(
    address: SocketAddr,
    endpoint: Endpoint,
    body: Option<&[u8]>,
    deadline: Instant,
    is_canceled: &C,
) -> Result<(TcpStream, ResponseHead), String>
where
    C: Fn() -> bool,
{
    ensure_fixed_loopback(address)?;
    if is_canceled() {
        return Err("Provider task was canceled.".into());
    }
    let connect_timeout = remaining_timeout(deadline)?.min(CONNECT_TIMEOUT);
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout).map_err(|_| {
        "LM Studio's local server is not running. In LM Studio, open Developer and start the server on 127.0.0.1:1234."
            .to_string()
    })?;
    stream
        .set_read_timeout(Some(READ_POLL_INTERVAL))
        .and_then(|_| stream.set_write_timeout(Some(connect_timeout)))
        .map_err(|error| format!("Could not configure the LM Studio connection: {error}"))?;
    let body = body.unwrap_or_default();
    let request = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nAccept: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.method(),
        endpoint.path(),
        endpoint.accept(),
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("Could not send the LM Studio request: {error}"))?;
    if is_canceled() {
        return Err("Provider task was canceled.".into());
    }
    let head = read_response_head(&mut stream, deadline, is_canceled)?;
    Ok((stream, head))
}

fn ensure_success_status(status: u16, endpoint: Endpoint) -> Result<(), String> {
    match status {
        200..=299 => Ok(()),
        300..=399 => Err(
            "LM Studio redirects are blocked because this provider may connect only to 127.0.0.1:1234."
                .into(),
        ),
        401 | 403 => Err(
            "LM Studio server authentication is enabled. Codelit's local-only LM Studio v1 provider does not read API tokens. In LM Studio, first turn off Serve on Local Network and confirm the server is bound only to 127.0.0.1. Then turn off Require Authentication and retry."
                .into(),
        ),
        404 if matches!(endpoint, Endpoint::Models) => Err(
            "LM Studio's v1 model API is unavailable. Update to LM Studio 0.4.0 or newer, start the local server, and retry."
                .into(),
        ),
        _ => Err(format!("LM Studio returned local HTTP status {status}.")),
    }
}

fn ensure_fixed_loopback(address: SocketAddr) -> Result<(), String> {
    if address.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        return Err("LM Studio access is restricted to 127.0.0.1 on this Mac.".into());
    }
    Ok(())
}

struct ResponseHead {
    status: u16,
    body: ResponseBody,
}

enum ResponseBody {
    Chunked,
    ContentLength(usize),
    UntilClose,
}

fn read_response_head<C>(
    stream: &mut TcpStream,
    deadline: Instant,
    is_canceled: &C,
) -> Result<ResponseHead, String>
where
    C: Fn() -> bool,
{
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= MAX_HEADER_BYTES {
            return Err("LM Studio returned oversized HTTP headers.".into());
        }
        let byte = read_exact_controlled(stream, 1, deadline, is_canceled)?;
        headers.push(byte[0]);
    }
    let headers = String::from_utf8(headers)
        .map_err(|_| "LM Studio returned invalid HTTP headers.".to_string())?;
    let status_line = headers
        .lines()
        .next()
        .filter(|line| line.starts_with("HTTP/1.1 ") || line.starts_with("HTTP/1.0 "))
        .ok_or("LM Studio returned an invalid HTTP status line.")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("LM Studio returned an invalid HTTP status.")?;
    let mut content_length = None;
    let mut transfer_encoding = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "LM Studio returned an invalid content length.")?,
            );
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            transfer_encoding = Some(value.trim().to_ascii_lowercase());
        }
    }
    let body = match transfer_encoding.as_deref() {
        Some("chunked") => ResponseBody::Chunked,
        Some(_) => return Err("LM Studio returned an unsupported transfer encoding.".into()),
        None => content_length
            .map(ResponseBody::ContentLength)
            .unwrap_or(ResponseBody::UntilClose),
    };
    Ok(ResponseHead { status, body })
}

fn read_response_body<C, F>(
    stream: &mut TcpStream,
    body: ResponseBody,
    deadline: Instant,
    is_canceled: &C,
    max_bytes: usize,
    mut accept: F,
) -> Result<(), String>
where
    C: Fn() -> bool,
    F: FnMut(&[u8]) -> Result<(), String>,
{
    let mut received = 0_usize;
    match body {
        ResponseBody::Chunked => loop {
            let size_line = read_http_line(stream, deadline, is_canceled, 128)?;
            let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "LM Studio returned an invalid chunk size.".to_string())?;
            if size == 0 {
                break;
            }
            if size > max_bytes.saturating_sub(received) {
                return Err("LM Studio returned output above the local response limit.".into());
            }
            let chunk = read_exact_controlled(stream, size, deadline, is_canceled)?;
            let terminator = read_exact_controlled(stream, 2, deadline, is_canceled)?;
            if terminator != b"\r\n" {
                return Err("LM Studio returned an invalid chunk terminator.".into());
            }
            received = received.saturating_add(chunk.len());
            accept(&chunk)?;
        },
        ResponseBody::ContentLength(length) => {
            if length > max_bytes {
                return Err("LM Studio returned output above the local response limit.".into());
            }
            let bytes = read_exact_controlled(stream, length, deadline, is_canceled)?;
            accept(&bytes)?;
        }
        ResponseBody::UntilClose => {
            let mut buffer = [0_u8; 8 * 1024];
            loop {
                match read_controlled(stream, &mut buffer, deadline, is_canceled)? {
                    0 => break,
                    count => {
                        received = received.saturating_add(count);
                        if received > max_bytes {
                            return Err(
                                "LM Studio returned output above the local response limit.".into(),
                            );
                        }
                        accept(&buffer[..count])?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn read_http_line<C>(
    stream: &mut TcpStream,
    deadline: Instant,
    is_canceled: &C,
    limit: usize,
) -> Result<String, String>
where
    C: Fn() -> bool,
{
    let mut line = Vec::new();
    while !line.ends_with(b"\r\n") {
        if line.len() >= limit {
            return Err("LM Studio returned an oversized HTTP line.".into());
        }
        let byte = read_exact_controlled(stream, 1, deadline, is_canceled)?;
        line.push(byte[0]);
    }
    line.truncate(line.len().saturating_sub(2));
    String::from_utf8(line).map_err(|_| "LM Studio returned an invalid HTTP line.".into())
}

fn read_exact_controlled<C>(
    stream: &mut TcpStream,
    length: usize,
    deadline: Instant,
    is_canceled: &C,
) -> Result<Vec<u8>, String>
where
    C: Fn() -> bool,
{
    let mut bytes = vec![0_u8; length];
    let mut offset = 0;
    while offset < length {
        let count = read_controlled(stream, &mut bytes[offset..], deadline, is_canceled)?;
        if count == 0 {
            return Err("LM Studio closed the local response early.".into());
        }
        offset += count;
    }
    Ok(bytes)
}

fn read_controlled<C>(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
    is_canceled: &C,
) -> Result<usize, String>
where
    C: Fn() -> bool,
{
    loop {
        if is_canceled() {
            return Err("Provider task was canceled.".into());
        }
        if Instant::now() >= deadline {
            return Err("LM Studio local generation timed out.".into());
        }
        match stream.read(buffer) {
            Ok(count) => return Ok(count),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(format!("Could not read the LM Studio response: {error}")),
        }
    }
}

#[derive(Default)]
struct SseState {
    line_buffer: Vec<u8>,
    generated: String,
    completed: bool,
}

impl SseState {
    fn push<F>(&mut self, bytes: &[u8], on_message: &mut F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        self.line_buffer.extend_from_slice(bytes);
        while let Some(newline) = self.line_buffer.iter().position(|byte| *byte == b'\n') {
            if newline > MAX_SSE_LINE_BYTES {
                return Err("LM Studio returned an oversized stream event.".into());
            }
            let line = self.line_buffer.drain(..=newline).collect::<Vec<_>>();
            self.consume_line(&line, on_message)?;
        }
        if self.line_buffer.len() > MAX_SSE_LINE_BYTES {
            return Err("LM Studio returned an oversized stream event.".into());
        }
        Ok(())
    }

    fn finish<F>(&mut self, on_message: &mut F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.consume_line(&line, on_message)?;
        }
        if !self.completed {
            return Err("LM Studio closed the structured stream before completion.".into());
        }
        Ok(())
    }

    fn consume_line<F>(&mut self, line: &[u8], on_message: &mut F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        let line = std::str::from_utf8(line)
            .map_err(|_| "LM Studio returned an invalid UTF-8 stream event.")?
            .trim();
        if line.is_empty() || line.starts_with(':') {
            return Ok(());
        }
        let payload = line
            .strip_prefix("data:")
            .ok_or("LM Studio returned an invalid structured stream event.")?
            .trim();
        if payload == "[DONE]" {
            self.completed = true;
            return Ok(());
        }
        if self.completed {
            return Err("LM Studio returned data after the stream completed.".into());
        }
        let chunk: ChatChunk = serde_json::from_str(payload)
            .map_err(|error| format!("LM Studio returned an invalid stream event: {error}"))?;
        if let Some(error) = chunk.error {
            return Err(format!(
                "LM Studio reported a local generation error: {}",
                sanitized_detail(&error.message)
            ));
        }
        if chunk.choices.len() > 1 {
            return Err("LM Studio returned multiple choices for a single local request.".into());
        }
        for choice in chunk.choices {
            if choice.delta.tool_calls.is_some() {
                return Err("LM Studio attempted tool use in a tool-free local request.".into());
            }
            if let Some(content) = choice.delta.content.filter(|content| !content.is_empty()) {
                if self.generated.len().saturating_add(content.len()) > MAX_STREAMED_OUTPUT_BYTES {
                    return Err(
                        "LM Studio returned output above the local generation limit.".into(),
                    );
                }
                self.generated.push_str(&content);
                on_message(&content);
            }
            if choice.finish_reason.is_some() {
                self.completed = true;
            }
        }
        Ok(())
    }
}

fn sanitized_detail(detail: &str) -> String {
    let detail = detail
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect::<String>();
    if detail.trim().is_empty() {
        "unknown local error".into()
    } else {
        detail
    }
}

fn deadline_after(timeout: Duration) -> Result<Instant, String> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| "The LM Studio timeout is outside the supported range.".into())
}

fn remaining_timeout(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "LM Studio local generation timed out.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;

    type RequestLog = Arc<Mutex<Vec<Vec<u8>>>>;
    type TestServer = (SocketAddr, RequestLog, thread::JoinHandle<()>);

    fn json_response(body: Value) -> Vec<u8> {
        let body = serde_json::to_vec(&body).expect("encode test body");
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        response
    }

    fn status_response(status: u16, reason: &str, headers: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status} {reason}\r\n{headers}Content-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn local_model(id: &str) -> Value {
        json!({
            "type": "llm",
            "publisher": "local-publisher",
            "key": id,
            "display_name": "Local Qwen",
            "architecture": "qwen2",
            "quantization": { "name": "Q4_K_M", "bits_per_weight": 4 },
            "size_bytes": 4_000_000_000_u64,
            "params_string": "7B",
            "loaded_instances": [],
            "max_context_length": 32_768,
            "format": "gguf",
            "capabilities": { "vision": false, "trained_for_tool_use": false }
        })
    }

    fn models_response(models: Vec<Value>) -> Vec<u8> {
        json_response(json!({ "models": models }))
    }

    fn sse_response(parts: &[&str]) -> Vec<u8> {
        let mut body = String::new();
        for part in parts {
            body.push_str("data: ");
            body.push_str(
                &json!({
                    "choices": [{
                        "delta": { "content": part },
                        "finish_reason": Value::Null
                    }]
                })
                .to_string(),
            );
            body.push_str("\n\n");
        }
        body.push_str("data: [DONE]\n\n");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
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

    fn request_path(request: &[u8]) -> &str {
        std::str::from_utf8(request)
            .expect("request utf8")
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .expect("request path")
    }

    fn request_body(request: &[u8]) -> Value {
        let header_end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("request headers");
        serde_json::from_slice(&request[header_end + 4..]).expect("request json")
    }

    fn serve_script(responses: Vec<Vec<u8>>, observe_extra_requests_for: Duration) -> TestServer {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test server");
        let address = listener.local_addr().expect("test address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept scripted request");
                let request = read_request(&mut stream);
                recorded.lock().expect("request log").push(request);
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
                        recorded.lock().expect("request log").push(request);
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
    fn stopped_server_returns_honest_setup_detail() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve port");
        let address = listener.local_addr().expect("test address");
        drop(listener);
        let error = list_models_at(address, Duration::from_millis(250), &|| false)
            .expect_err("stopped server");
        assert!(error.contains("local server is not running"));
        assert!(error.contains("127.0.0.1:1234"));
    }

    #[test]
    fn lists_only_completion_capable_local_models() {
        let mut embedding = local_model("local/embedding");
        embedding["type"] = json!("embedding");
        let mut zero_size = local_model("local/zero");
        zero_size["size_bytes"] = json!(0);
        let mut remote_key = local_model("local/remote");
        remote_key["key"] = json!("https://example.invalid/model");
        let mut remote_instance = local_model("local/remote-instance");
        remote_instance["loaded_instances"] =
            json!([{ "id": "https://example.invalid/instance", "config": {} }]);
        let mut unsupported_format = local_model("local/safetensors");
        unsupported_format["format"] = json!("safetensors");
        let (address, requests, server) = serve_script(
            vec![models_response(vec![
                local_model("local/qwen-7b@q4_k_m"),
                embedding,
                zero_size,
                remote_key,
                remote_instance,
                unsupported_format,
            ])],
            Duration::ZERO,
        );
        let models =
            list_models_at(address, Duration::from_secs(1), &|| false).expect("local models");
        server.join().expect("test server");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "local/qwen-7b@q4_k_m");
        assert_eq!(models[0].format, "gguf");
        let requests = requests.lock().expect("request log");
        assert_eq!(requests.len(), 1);
        assert_eq!(request_path(&requests[0]), "/api/v1/models");
    }

    #[test]
    fn authentication_enabled_fails_without_reading_or_sending_a_token() {
        let (address, requests, server) = serve_script(
            vec![status_response(401, "Unauthorized", "")],
            Duration::ZERO,
        );
        let error = list_models_at(address, Duration::from_secs(1), &|| false)
            .expect_err("authentication must require setup change");
        server.join().expect("test server");
        assert!(error.contains("authentication is enabled"));
        assert!(error.contains("turn off Serve on Local Network"));
        assert!(error.contains("bound only to 127.0.0.1"));
        assert!(error.contains("does not read API tokens"));
        let request =
            String::from_utf8_lossy(&requests.lock().expect("request log")[0]).to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
    }

    #[test]
    fn redirects_and_non_loopback_addresses_are_denied() {
        let (address, requests, server) = serve_script(
            vec![status_response(
                307,
                "Temporary Redirect",
                "Location: https://example.invalid/models\r\n",
            )],
            Duration::from_millis(100),
        );
        let error = list_models_at(address, Duration::from_secs(1), &|| false)
            .expect_err("redirect must be rejected");
        server.join().expect("test server");
        assert!(error.contains("redirects are blocked"));
        assert_eq!(requests.lock().expect("request log").len(), 1);

        let remote = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 1_234);
        assert!(list_models_at(remote, Duration::from_millis(1), &|| false).is_err());
    }

    #[test]
    fn streams_and_validates_strict_structured_generation_without_tools_or_state() {
        let (address, requests, server) = serve_script(
            vec![
                models_response(vec![local_model("local/qwen-7b@q4_k_m")]),
                sse_response(&["{\"summary\":\"local", " ready\",\"items\":[\"offline\"]}"]),
            ],
            Duration::ZERO,
        );
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let recorded_chunks = chunks.clone();
        let value = generate_structured_at(
            address,
            "local/qwen-7b@q4_k_m",
            "health check",
            Duration::from_secs(2),
            &|| false,
            move |chunk| {
                recorded_chunks
                    .lock()
                    .expect("chunk log")
                    .push(chunk.to_string())
            },
        )
        .expect("structured generation");
        server.join().expect("test server");
        assert_eq!(value["summary"], "local ready");
        assert_eq!(value["items"], json!(["offline"]));
        assert_eq!(chunks.lock().expect("chunk log").len(), 2);

        let requests = requests.lock().expect("request log");
        assert_eq!(
            requests
                .iter()
                .map(|request| request_path(request))
                .collect::<Vec<_>>(),
            ["/api/v1/models", "/v1/chat/completions"]
        );
        let body = request_body(&requests[1]);
        assert_eq!(body["stream"], true);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["additionalProperties"],
            false
        );
        for denied in [
            "tools",
            "tool_choice",
            "integrations",
            "previous_response_id",
            "store",
            "session",
        ] {
            assert!(body.get(denied).is_none(), "unexpected field {denied}");
        }
    }

    #[test]
    fn invalid_structured_output_is_rejected() {
        let (address, _, server) = serve_script(
            vec![
                models_response(vec![local_model("local/qwen")]),
                sse_response(&[r#"{"summary":"ready","items":[],"extra":true}"#]),
            ],
            Duration::ZERO,
        );
        let error = generate_structured_at(
            address,
            "local/qwen",
            "health check",
            Duration::from_secs(1),
            &|| false,
            |_| {},
        )
        .expect_err("unknown structured fields must fail");
        server.join().expect("test server");
        assert!(error.contains("invalid structured output"));
    }

    #[test]
    fn generation_can_be_canceled_while_the_local_server_is_idle() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test server");
        let address = listener.local_addr().expect("test address");
        let (started_tx, started_rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept model request");
            let _ = read_request(&mut stream);
            stream
                .write_all(&models_response(vec![local_model("local/qwen")]))
                .expect("write models");
            let (mut stream, _) = listener.accept().expect("accept generation request");
            let _ = read_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .expect("write stream headers");
            started_tx.send(()).expect("signal generation");
            thread::sleep(Duration::from_secs(2));
        });
        let canceled = Arc::new(AtomicBool::new(false));
        let cancel_flag = canceled.clone();
        thread::spawn(move || {
            started_rx.recv().expect("generation start");
            thread::sleep(Duration::from_millis(75));
            cancel_flag.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let error = generate_structured_at(
            address,
            "local/qwen",
            "health check",
            Duration::from_secs(5),
            &|| canceled.load(Ordering::Acquire),
            |_| {},
        )
        .expect_err("cancel generation");
        assert!(error.contains("canceled"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn generation_output_is_bounded_before_delivery() {
        let oversized = "x".repeat(MAX_STREAMED_OUTPUT_BYTES + 1);
        let (address, _, server) = serve_script(
            vec![
                models_response(vec![local_model("local/qwen")]),
                sse_response(&[&oversized]),
            ],
            Duration::ZERO,
        );
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let recorded = delivered.clone();
        let error = generate_structured_at(
            address,
            "local/qwen",
            "health check",
            Duration::from_secs(1),
            &|| false,
            move |chunk| {
                recorded
                    .lock()
                    .expect("delivery log")
                    .push(chunk.to_string())
            },
        )
        .expect_err("oversized output");
        server.join().expect("test server");
        assert!(error.contains("generation limit"));
        assert!(delivered.lock().expect("delivery log").is_empty());
    }

    #[test]
    fn preflight_failure_sends_no_prompt_or_generation_request() {
        let (address, requests, server) = serve_script(
            vec![models_response(vec![local_model("local/other")])],
            Duration::from_millis(150),
        );
        let error = generate_structured_at(
            address,
            "local/missing",
            "TOP SECRET PROMPT",
            Duration::from_secs(1),
            &|| false,
            |_| {},
        )
        .expect_err("missing model must fail preflight");
        server.join().expect("test server");
        assert!(error.contains("completion-capable local model"));
        let requests = requests.lock().expect("request log");
        assert_eq!(requests.len(), 1);
        assert_eq!(request_path(&requests[0]), "/api/v1/models");
        assert!(!String::from_utf8_lossy(&requests[0]).contains("TOP SECRET PROMPT"));
    }
}
