use crate::provider_credentials::{ByokProvider, SecretBytes};
use reqwest::StatusCode;
use reqwest::blocking::{Client, Response};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt;
use std::io::Read;
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::{Duration, Instant};

const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const GEMINI_INTERACTIONS_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_MODEL_BYTES: usize = 160;
const MAX_OUTPUT_TOKENS: usize = 1_024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SSE_LINE_BYTES: usize = 128 * 1024;
const MAX_SSE_FRAME_BYTES: usize = 256 * 1024;
const MAX_STREAMED_STRUCTURED_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_SUMMARY_BYTES: usize = 2_800;
const MAX_STRUCTURED_ITEMS: usize = 3;
const MAX_STRUCTURED_ITEM_BYTES: usize = 350;
const MAX_FORMATTED_ANSWER_BYTES: usize = 4_000;

#[derive(Debug, Clone)]
pub struct ByokApiRequest {
    pub provider: ByokProvider,
    pub model: String,
    pub prompt: String,
    pub timeout: Duration,
}

impl ByokApiRequest {
    pub fn new(
        provider: ByokProvider,
        model: impl Into<String>,
        prompt: impl Into<String>,
    ) -> Result<Self, ByokApiError> {
        let request = Self {
            provider,
            model: model.into(),
            prompt: prompt.into(),
            timeout: DEFAULT_TIMEOUT,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, ByokApiError> {
        self.timeout = timeout;
        self.validate()?;
        Ok(self)
    }

    fn validate(&self) -> Result<(), ByokApiError> {
        if self.prompt.trim().is_empty() || self.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(ByokApiError::invalid_request(
                "The provider prompt must contain between 1 and 8,000 characters.",
            ));
        }
        if self.model.is_empty()
            || self.model.len() > MAX_MODEL_BYTES
            || !self.model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
            })
        {
            return Err(ByokApiError::invalid_request(
                "The selected provider model name is invalid.",
            ));
        }
        if self.timeout.is_zero() || self.timeout > MAX_TIMEOUT {
            return Err(ByokApiError::invalid_request(
                "The provider timeout must be between 1 millisecond and 5 minutes.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ByokApiErrorCode {
    InvalidRequest,
    SignedOut,
    QuotaHit,
    ProviderUnavailable,
    Timeout,
    Canceled,
    ResponseTooLarge,
    InvalidOutput,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ByokApiError {
    pub code: ByokApiErrorCode,
    pub message: String,
}

impl ByokApiError {
    fn new(code: ByokApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_request(message: &'static str) -> Self {
        Self::new(ByokApiErrorCode::InvalidRequest, message)
    }

    fn canceled() -> Self {
        Self::new(
            ByokApiErrorCode::Canceled,
            "The provider request was canceled.",
        )
    }

    fn timeout() -> Self {
        Self::new(ByokApiErrorCode::Timeout, "The provider request timed out.")
    }

    fn provider_unavailable() -> Self {
        Self::new(
            ByokApiErrorCode::ProviderUnavailable,
            "The selected provider could not complete the request.",
        )
    }

    fn invalid_output() -> Self {
        Self::new(
            ByokApiErrorCode::InvalidOutput,
            "The selected provider returned an invalid structured response.",
        )
    }

    fn response_too_large() -> Self {
        Self::new(
            ByokApiErrorCode::ResponseTooLarge,
            "The selected provider response exceeded Codelit's safety limit.",
        )
    }
}

impl fmt::Display for ByokApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ByokApiError {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredAnswer {
    pub summary: String,
    pub items: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnvalidatedStructuredAnswer {
    summary: String,
    items: Vec<String>,
}

impl StructuredAnswer {
    pub fn parse(raw: &str) -> Result<Self, ByokApiError> {
        let candidate: UnvalidatedStructuredAnswer =
            serde_json::from_str(raw).map_err(|_| ByokApiError::invalid_output())?;
        if candidate.summary.len() > MAX_STRUCTURED_SUMMARY_BYTES
            || candidate.items.len() > MAX_STRUCTURED_ITEMS
        {
            return Err(ByokApiError::invalid_output());
        }

        let summary = candidate.summary.trim().to_owned();
        if summary.is_empty() {
            return Err(ByokApiError::invalid_output());
        }

        let mut items = Vec::with_capacity(candidate.items.len());
        let mut formatted_bytes = summary.len();
        for item in candidate.items {
            if item.len() > MAX_STRUCTURED_ITEM_BYTES {
                return Err(ByokApiError::invalid_output());
            }
            let item = item.trim().to_owned();
            if item.is_empty() {
                return Err(ByokApiError::invalid_output());
            }
            formatted_bytes = formatted_bytes.saturating_add(3 + item.len());
            items.push(item);
        }
        if formatted_bytes > MAX_FORMATTED_ANSWER_BYTES {
            return Err(ByokApiError::invalid_output());
        }
        Ok(Self { summary, items })
    }

    pub fn formatted_text(&self) -> String {
        let mut output = self.summary.clone();
        for item in &self.items {
            output.push_str("\n- ");
            output.push_str(item);
        }
        output
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ByokStreamEvent {
    InvocationStarted,
    OutputDelta { delta: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByokApiResponse {
    pub provider: ByokProvider,
    pub model: String,
    pub structured_output: StructuredAnswer,
    pub text: String,
    pub duration_ms: u64,
    /// Always true: this path uses one host-selected, metered API key.
    pub metered: bool,
    /// Always false: this module never retries against a different provider.
    pub fallback_used: bool,
}

/// Executes exactly one host-selected API-key provider. It never retries against another provider,
/// reads environment variables, or launches a subprocess.
pub fn execute_byok_request<C, E>(
    request: &ByokApiRequest,
    credential: &SecretBytes,
    mut is_canceled: C,
    mut emit: E,
) -> Result<ByokApiResponse, ByokApiError>
where
    C: FnMut() -> bool,
    E: FnMut(ByokStreamEvent),
{
    request.validate()?;
    if is_canceled() {
        return Err(ByokApiError::canceled());
    }

    let started = Instant::now();
    let plan = request_plan(request);
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(request.timeout.min(CONNECT_TIMEOUT))
        .timeout(request.timeout)
        .build()
        .map_err(|_| ByokApiError::provider_unavailable())?;

    let headers = provider_headers(request.provider, credential)?;
    let response = send_provider_request(
        client.post(plan.endpoint).headers(headers).json(&plan.body),
        &mut emit,
    )?;
    let response = validate_http_response(response)?;
    let deadline = started.checked_add(request.timeout).unwrap_or(started);
    let structured_output = consume_provider_stream(
        response,
        request.provider,
        deadline,
        &mut is_canceled,
        &mut emit,
    )?;
    let text = structured_output.formatted_text();

    Ok(ByokApiResponse {
        provider: request.provider,
        model: request.model.clone(),
        structured_output,
        text,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        metered: true,
        fallback_used: false,
    })
}

fn send_provider_request<E>(
    request: reqwest::blocking::RequestBuilder,
    emit: &mut E,
) -> Result<Response, ByokApiError>
where
    E: FnMut(ByokStreamEvent),
{
    emit(ByokStreamEvent::InvocationStarted);
    request.send().map_err(map_reqwest_error)
}

struct ProviderRequestPlan {
    endpoint: &'static str,
    body: Value,
}

fn request_plan(request: &ByokApiRequest) -> ProviderRequestPlan {
    let schema = output_schema();
    match request.provider {
        ByokProvider::OpenAi => ProviderRequestPlan {
            endpoint: OPENAI_RESPONSES_URL,
            body: json!({
                "model": request.model,
                "input": request.prompt,
                "stream": true,
                "store": false,
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "reasoning": { "effort": "low" },
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "codelit_answer",
                        "strict": true,
                        "schema": schema
                    }
                }
            }),
        },
        ByokProvider::Anthropic => ProviderRequestPlan {
            endpoint: ANTHROPIC_MESSAGES_URL,
            body: json!({
                "model": request.model,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "thinking": {"type": "disabled"},
                "stream": true,
                "messages": [{"role": "user", "content": request.prompt}],
                "output_config": {
                    "format": {
                        "type": "json_schema",
                        "schema": schema
                    }
                }
            }),
        },
        ByokProvider::Gemini => ProviderRequestPlan {
            endpoint: GEMINI_INTERACTIONS_URL,
            body: json!({
                "model": request.model,
                "input": request.prompt,
                "stream": true,
                "store": false,
                "generation_config": {
                    "max_output_tokens": MAX_OUTPUT_TOKENS,
                    "thinking_level": "low",
                    "thinking_summaries": "none"
                },
                "response_format": {
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": schema
                }
            }),
        },
    }
}

fn output_schema() -> Value {
    // Keep the wire schema to the common strict subset accepted by all three providers.
    // Byte/item limits are enforced again by `StructuredAnswer::parse` below.
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "summary": {
                "type": "string",
                "description": "A non-empty answer no longer than 2,800 UTF-8 bytes."
            },
            "items": {
                "type": "array",
                "items": {
                    "type": "string",
                    "description": "A non-empty supporting item no longer than 350 UTF-8 bytes."
                },
                "description": "At most three supporting items."
            }
        },
        "required": ["summary", "items"]
    })
}

fn provider_headers(
    provider: ByokProvider,
    credential: &SecretBytes,
) -> Result<HeaderMap, ByokApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(USER_AGENT, HeaderValue::from_static("Codelit-mac/0.1"));

    match provider {
        ByokProvider::OpenAi => {
            let mut bearer = Vec::with_capacity(7 + credential.expose().len());
            bearer.extend_from_slice(b"Bearer ");
            bearer.extend_from_slice(credential.expose());
            let result = sensitive_header(&bearer);
            wipe(&mut bearer);
            headers.insert(AUTHORIZATION, result?);
        }
        ByokProvider::Anthropic => {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                sensitive_header(credential.expose())?,
            );
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        }
        ByokProvider::Gemini => {
            headers.insert(
                HeaderName::from_static("x-goog-api-key"),
                sensitive_header(credential.expose())?,
            );
        }
    }
    Ok(headers)
}

fn sensitive_header(value: &[u8]) -> Result<HeaderValue, ByokApiError> {
    let mut header = HeaderValue::from_bytes(value)
        .map_err(|_| ByokApiError::invalid_request("The selected provider API key is invalid."))?;
    header.set_sensitive(true);
    Ok(header)
}

fn validate_http_response(response: Response) -> Result<Response, ByokApiError> {
    let status = response.status();
    if !status.is_success() {
        return Err(error_for_status(status));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
    {
        return Err(ByokApiError::invalid_output());
    }
    Ok(response)
}

fn map_reqwest_error(error: reqwest::Error) -> ByokApiError {
    if error.is_timeout() {
        ByokApiError::timeout()
    } else {
        ByokApiError::provider_unavailable()
    }
}

fn error_for_status(status: StatusCode) -> ByokApiError {
    match status.as_u16() {
        401 | 403 => ByokApiError::new(
            ByokApiErrorCode::SignedOut,
            "The selected provider rejected this API key.",
        ),
        408 | 504 => ByokApiError::timeout(),
        429 => ByokApiError::new(
            ByokApiErrorCode::QuotaHit,
            "The selected provider rate-limited this API key.",
        ),
        _ => ByokApiError::provider_unavailable(),
    }
}

fn consume_provider_stream<R, C, E>(
    mut reader: R,
    provider: ByokProvider,
    deadline: Instant,
    is_canceled: &mut C,
    emit: &mut E,
) -> Result<StructuredAnswer, ByokApiError>
where
    R: Read,
    C: FnMut() -> bool,
    E: FnMut(ByokStreamEvent),
{
    let mut decoder = SseDecoder::default();
    let mut state = ProviderStreamState::new(provider);
    let mut buffer = [0_u8; 8 * 1024];

    loop {
        check_control(deadline, is_canceled)?;
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Err(ByokApiError::timeout());
            }
            Err(_) => return Err(ByokApiError::provider_unavailable()),
        };
        if count == 0 {
            break;
        }
        decoder.push(&buffer[..count], |frame| state.process(frame, emit))?;
    }
    decoder.finish(|frame| state.process(frame, emit))?;
    check_control(deadline, is_canceled)?;
    state.finish(emit)
}

fn check_control<C>(deadline: Instant, is_canceled: &mut C) -> Result<(), ByokApiError>
where
    C: FnMut() -> bool,
{
    if is_canceled() {
        Err(ByokApiError::canceled())
    } else if Instant::now() >= deadline {
        Err(ByokApiError::timeout())
    } else {
        Ok(())
    }
}

struct ProviderStreamState {
    provider: ByokProvider,
    raw: String,
    summary: StructuredSummaryStream,
    completed: bool,
}

impl ProviderStreamState {
    fn new(provider: ByokProvider) -> Self {
        Self {
            provider,
            raw: String::new(),
            summary: StructuredSummaryStream::default(),
            completed: false,
        }
    }

    fn process<E>(&mut self, frame: &[u8], emit: &mut E) -> Result<(), ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        if frame == b"[DONE]" {
            return Ok(());
        }
        let event: Value =
            serde_json::from_slice(frame).map_err(|_| ByokApiError::invalid_output())?;
        match self.provider {
            ByokProvider::OpenAi => self.process_openai(&event, emit),
            ByokProvider::Anthropic => self.process_anthropic(&event, emit),
            ByokProvider::Gemini => self.process_gemini(&event, emit),
        }
    }

    fn process_openai<E>(&mut self, event: &Value, emit: &mut E) -> Result<(), ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_text.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or_else(ByokApiError::invalid_output)?;
                self.append(delta, emit)
            }
            "response.completed" => {
                self.completed = true;
                Ok(())
            }
            "error" | "response.failed" | "response.incomplete" => {
                Err(ByokApiError::provider_unavailable())
            }
            _ => Ok(()),
        }
    }

    fn process_anthropic<E>(&mut self, event: &Value, emit: &mut E) -> Result<(), ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "content_block_delta"
                if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") =>
            {
                let delta = event
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .ok_or_else(ByokApiError::invalid_output)?;
                self.append(delta, emit)
            }
            "message_stop" => {
                self.completed = true;
                Ok(())
            }
            "error" => Err(ByokApiError::provider_unavailable()),
            _ => Ok(()),
        }
    }

    fn process_gemini<E>(&mut self, event: &Value, emit: &mut E) -> Result<(), ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        let event_type = event
            .get("event_type")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "step.delta"
                if event.pointer("/delta/type").and_then(Value::as_str) == Some("text") =>
            {
                let delta = event
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .ok_or_else(ByokApiError::invalid_output)?;
                self.append(delta, emit)
            }
            "interaction.completed" => {
                self.completed = true;
                Ok(())
            }
            "error" | "interaction.failed" | "interaction.cancelled" => {
                Err(ByokApiError::provider_unavailable())
            }
            _ => Ok(()),
        }
    }

    fn append<E>(&mut self, delta: &str, emit: &mut E) -> Result<(), ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        if self.raw.len().saturating_add(delta.len()) > MAX_STREAMED_STRUCTURED_BYTES {
            return Err(ByokApiError::response_too_large());
        }
        self.raw.push_str(delta);
        if let Some(delta) = self.summary.push(&self.raw) {
            emit(ByokStreamEvent::OutputDelta { delta });
        }
        Ok(())
    }

    fn finish<E>(mut self, emit: &mut E) -> Result<StructuredAnswer, ByokApiError>
    where
        E: FnMut(ByokStreamEvent),
    {
        if !self.completed {
            return Err(ByokApiError::provider_unavailable());
        }
        let answer = StructuredAnswer::parse(&self.raw)?;
        if let Some(delta) = self.summary.finish(&answer.summary) {
            emit(ByokStreamEvent::OutputDelta { delta });
        }
        Ok(answer)
    }
}

#[derive(Default)]
struct StructuredSummaryStream {
    emitted: String,
}

impl StructuredSummaryStream {
    fn push(&mut self, raw: &str) -> Option<String> {
        let summary = streamed_summary_prefix(raw)?;
        self.emit_new(&summary)
    }

    fn finish(&mut self, summary: &str) -> Option<String> {
        self.emit_new(summary)
    }

    fn emit_new(&mut self, summary: &str) -> Option<String> {
        let bounded = utf8_prefix(summary, MAX_STRUCTURED_SUMMARY_BYTES);
        let delta = bounded.strip_prefix(&self.emitted)?;
        if delta.is_empty() {
            return None;
        }
        let delta = delta.to_owned();
        self.emitted = bounded.to_owned();
        Some(delta)
    }
}

#[derive(Default)]
struct SseDecoder {
    total_bytes: usize,
    pending_line: Vec<u8>,
    frame_data: Vec<u8>,
}

impl SseDecoder {
    fn push<F>(&mut self, bytes: &[u8], mut on_frame: F) -> Result<(), ByokApiError>
    where
        F: FnMut(&[u8]) -> Result<(), ByokApiError>,
    {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        if self.total_bytes > MAX_RESPONSE_BYTES {
            return Err(ByokApiError::response_too_large());
        }

        for byte in bytes {
            if *byte == b'\n' {
                self.finish_line(&mut on_frame)?;
            } else {
                self.pending_line.push(*byte);
                if self.pending_line.len() > MAX_SSE_LINE_BYTES {
                    return Err(ByokApiError::response_too_large());
                }
            }
        }
        Ok(())
    }

    fn finish<F>(&mut self, mut on_frame: F) -> Result<(), ByokApiError>
    where
        F: FnMut(&[u8]) -> Result<(), ByokApiError>,
    {
        if !self.pending_line.is_empty() {
            self.finish_line(&mut on_frame)?;
        }
        self.dispatch(&mut on_frame)
    }

    fn finish_line<F>(&mut self, on_frame: &mut F) -> Result<(), ByokApiError>
    where
        F: FnMut(&[u8]) -> Result<(), ByokApiError>,
    {
        if self.pending_line.last() == Some(&b'\r') {
            self.pending_line.pop();
        }
        if self.pending_line.is_empty() {
            self.dispatch(on_frame)?;
            return Ok(());
        }

        if let Some(data) = self.pending_line.strip_prefix(b"data:") {
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if !self.frame_data.is_empty() {
                self.frame_data.push(b'\n');
            }
            self.frame_data.extend_from_slice(data);
            if self.frame_data.len() > MAX_SSE_FRAME_BYTES {
                return Err(ByokApiError::response_too_large());
            }
        }
        self.pending_line.clear();
        Ok(())
    }

    fn dispatch<F>(&mut self, on_frame: &mut F) -> Result<(), ByokApiError>
    where
        F: FnMut(&[u8]) -> Result<(), ByokApiError>,
    {
        if self.frame_data.is_empty() {
            return Ok(());
        }
        let result = on_frame(&self.frame_data);
        self.frame_data.clear();
        result
    }
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn streamed_summary_prefix(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut depth = 0_i32;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                index += 1;
            }
            b'"' => {
                let start = index;
                let end = complete_json_string_end(bytes, start)?;
                index = end + 1;
                if depth != 1 {
                    continue;
                }
                let mut separator = index;
                while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                    separator += 1;
                }
                if bytes.get(separator) != Some(&b':') {
                    continue;
                }
                let key = serde_json::from_slice::<String>(&bytes[start..=end]).ok()?;
                if key != "summary" {
                    continue;
                }
                separator += 1;
                while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                    separator += 1;
                }
                if bytes.get(separator) != Some(&b'"') {
                    return None;
                }
                return partial_json_string(value, separator);
            }
            _ => index += 1,
        }
    }
    None
}

fn complete_json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(start + 1) {
        if escaped {
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            return Some(index);
        }
    }
    None
}

fn partial_json_string(value: &str, start: usize) -> Option<String> {
    let bytes = value.as_bytes();
    if let Some(end) = complete_json_string_end(bytes, start) {
        return serde_json::from_slice::<String>(&bytes[start..=end]).ok();
    }

    let mut raw_end = value.len();
    while raw_end > start + 1 {
        let candidate = format!("{}\"", &value[start..raw_end]);
        if let Ok(decoded) = serde_json::from_str::<String>(&candidate) {
            return Some(decoded);
        }
        raw_end -= 1;
        while raw_end > start + 1 && !value.is_char_boundary(raw_end) {
            raw_end -= 1;
        }
    }
    Some(String::new())
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: `byte` is a valid, uniquely borrowed byte in this allocation.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn request(provider: ByokProvider) -> ByokApiRequest {
        ByokApiRequest::new(provider, "test-model-1", "Answer the question.").unwrap()
    }

    fn stream(provider: ByokProvider, events: &[&str]) -> (StructuredAnswer, Vec<String>) {
        let bytes = events.join("\n\n");
        let mut deltas = Vec::new();
        let answer = consume_provider_stream(
            Cursor::new(bytes),
            provider,
            Instant::now() + Duration::from_secs(1),
            &mut || false,
            &mut |event| match event {
                ByokStreamEvent::InvocationStarted => {}
                ByokStreamEvent::OutputDelta { delta } => deltas.push(delta),
            },
        )
        .unwrap();
        (answer, deltas)
    }

    #[test]
    fn request_plans_use_only_fixed_https_provider_hosts() {
        let cases = [
            (ByokProvider::OpenAi, OPENAI_RESPONSES_URL),
            (ByokProvider::Anthropic, ANTHROPIC_MESSAGES_URL),
            (ByokProvider::Gemini, GEMINI_INTERACTIONS_URL),
        ];
        for (provider, expected) in cases {
            let plan = request_plan(&request(provider));
            assert_eq!(plan.endpoint, expected);
            assert!(plan.endpoint.starts_with("https://"));
            assert!(!plan.endpoint.contains("test-model"));
        }
    }

    #[test]
    fn request_plans_select_current_structured_streaming_shapes() {
        let openai = request_plan(&request(ByokProvider::OpenAi)).body;
        assert_eq!(openai["stream"], true);
        assert_eq!(openai["store"], false);
        assert_eq!(openai["reasoning"]["effort"], "low");
        assert_eq!(openai["text"]["format"]["type"], "json_schema");
        assert_eq!(openai["text"]["format"]["strict"], true);

        let anthropic = request_plan(&request(ByokProvider::Anthropic)).body;
        assert_eq!(anthropic["stream"], true);
        assert_eq!(anthropic["thinking"]["type"], "disabled");
        assert_eq!(anthropic["output_config"]["format"]["type"], "json_schema");
        assert!(anthropic.get("tools").is_none());

        let gemini = request_plan(&request(ByokProvider::Gemini)).body;
        assert_eq!(gemini["stream"], true);
        assert_eq!(gemini["store"], false);
        assert_eq!(gemini["generation_config"]["thinking_level"], "low");
        assert_eq!(gemini["generation_config"]["thinking_summaries"], "none");
        assert_eq!(gemini["response_format"]["type"], "text");
        assert_eq!(gemini["response_format"]["mime_type"], "application/json");
        assert!(gemini.get("tools").is_none());

        let schema = output_schema().to_string();
        assert!(!schema.contains("minLength"));
        assert!(!schema.contains("maxLength"));
        assert!(!schema.contains("maxItems"));
    }

    #[test]
    fn headers_are_sensitive_and_provider_specific() {
        let secret = SecretBytes::from_string("test-secret-key".into()).unwrap();
        let openai = provider_headers(ByokProvider::OpenAi, &secret).unwrap();
        assert!(openai[AUTHORIZATION].is_sensitive());
        assert!(openai.get("x-api-key").is_none());

        let anthropic = provider_headers(ByokProvider::Anthropic, &secret).unwrap();
        assert!(anthropic["x-api-key"].is_sensitive());
        assert_eq!(anthropic["anthropic-version"], "2023-06-01");

        let gemini = provider_headers(ByokProvider::Gemini, &secret).unwrap();
        assert!(gemini["x-goog-api-key"].is_sensitive());
        assert!(gemini.get(AUTHORIZATION).is_none());
    }

    #[test]
    fn invocation_event_is_emitted_only_at_the_http_send_boundary() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let (observed_tx, observed_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept provider request");
            let mut request = [0_u8; 2_048];
            let read = stream.read(&mut request).expect("read provider request");
            observed_tx
                .send(String::from_utf8_lossy(&request[..read]).into_owned())
                .expect("report provider request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .expect("write provider response");
        });

        let client = Client::builder().no_proxy().build().expect("test client");
        let mut events = Vec::new();
        let response = send_provider_request(
            client
                .post(format!("http://{address}/metered"))
                .body("test"),
            &mut |event| events.push(event),
        )
        .expect("request reached test server");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(events, [ByokStreamEvent::InvocationStarted]);
        assert!(
            observed_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("observed request")
                .starts_with("POST /metered HTTP/1.1")
        );
        server.join().expect("test server stopped");
    }

    #[test]
    fn parses_openai_anthropic_and_gemini_streams() {
        let summary = r#"{"summary":"Use a read-only role","items":["Rotate the key"]}"#;

        let (openai, openai_deltas) = stream(
            ByokProvider::OpenAi,
            &[
                &format!(
                    "data: {}",
                    json!({"type":"response.output_text.delta","delta":summary})
                ),
                r#"data: {"type":"response.completed"}"#,
            ],
        );
        assert_eq!(openai.summary, "Use a read-only role");
        assert_eq!(openai_deltas.concat(), openai.summary);

        let (anthropic, anthropic_deltas) = stream(
            ByokProvider::Anthropic,
            &[
                &format!(
                    "data: {}",
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":summary}})
                ),
                r#"data: {"type":"message_stop"}"#,
            ],
        );
        assert_eq!(anthropic.summary, "Use a read-only role");
        assert_eq!(anthropic_deltas.concat(), anthropic.summary);

        let (gemini, gemini_deltas) = stream(
            ByokProvider::Gemini,
            &[
                &format!(
                    "data: {}",
                    json!({"event_type":"step.delta","delta":{"type":"text","text":summary}})
                ),
                r#"data: {"event_type":"interaction.completed"}"#,
            ],
        );
        assert_eq!(gemini.summary, "Use a read-only role");
        assert_eq!(gemini_deltas.concat(), gemini.summary);
    }

    #[test]
    fn sse_decoder_handles_chunk_boundaries_and_multiline_data() {
        let mut decoder = SseDecoder::default();
        let mut frames = Vec::new();
        decoder
            .push(b"event: example\r\nda", |frame| {
                frames.push(frame.to_vec());
                Ok(())
            })
            .unwrap();
        decoder
            .push(b"ta: one\ndata: two\n\n", |frame| {
                frames.push(frame.to_vec());
                Ok(())
            })
            .unwrap();
        decoder
            .finish(|frame| {
                frames.push(frame.to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(frames, vec![b"one\ntwo".to_vec()]);
    }

    #[test]
    fn rejects_unknown_fields_and_bounded_output_overflow() {
        assert_eq!(
            StructuredAnswer::parse(r#"{"summary":"ok","items":[],"secret":"no"}"#)
                .unwrap_err()
                .code,
            ByokApiErrorCode::InvalidOutput
        );
        let oversized = json!({
            "summary": "x".repeat(MAX_STRUCTURED_SUMMARY_BYTES + 1),
            "items": []
        })
        .to_string();
        assert_eq!(
            StructuredAnswer::parse(&oversized).unwrap_err().code,
            ByokApiErrorCode::InvalidOutput
        );
    }

    #[test]
    fn cancellation_is_checked_before_stream_reads() {
        let result = consume_provider_stream(
            Cursor::new(Vec::<u8>::new()),
            ByokProvider::OpenAi,
            Instant::now() + Duration::from_secs(1),
            &mut || true,
            &mut |_| {},
        );
        assert_eq!(result.unwrap_err().code, ByokApiErrorCode::Canceled);
    }

    #[test]
    fn non_success_statuses_are_safely_classified() {
        assert_eq!(
            error_for_status(StatusCode::UNAUTHORIZED).code,
            ByokApiErrorCode::SignedOut
        );
        assert_eq!(
            error_for_status(StatusCode::TOO_MANY_REQUESTS).code,
            ByokApiErrorCode::QuotaHit
        );
        assert_eq!(
            error_for_status(StatusCode::TEMPORARY_REDIRECT).code,
            ByokApiErrorCode::ProviderUnavailable
        );
    }
}
