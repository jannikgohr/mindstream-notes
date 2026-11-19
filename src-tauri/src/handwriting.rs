//! Handwriting recognition through a vision model the user points the app at.
//!
//! The editor renders a page's strokes to an image and this sends it to an
//! OpenAI-compatible `chat/completions` endpoint (Ollama, a self-hosted server
//! or a hosted API). The request is made here rather than by `fetch` in the
//! WebView for the reasons given in `spellcheck::http_checker`: no CORS on
//! self-hosted servers, Private Network Access and mixed content.
//!
//! NETWORK BOUNDARY: the page image leaves the device, to the configured
//! endpoint only, and only once one is set.

use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult, CommandResult};

const PROMPT: &str = "Transcribe all handwritten text in this image exactly as written, \
in its original language (usually German or English). Keep the line breaks. \
Do not translate, correct, describe or add anything. \
Reply with the plain text only, without Markdown, headings or labels. \
If there is no legible text, reply with nothing.";
const IMAGE_PREFIX: &str = "data:image/png;base64,";
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
// Vision models on a CPU-only machine take minutes per page.
const TIMEOUT: Duration = Duration::from_secs(300);
// A dense page is well under this; small models can otherwise repeat a line
// until the timeout.
const MAX_TOKENS: u32 = 4096;

fn completions_url(endpoint: &str) -> AppResult<String> {
    let base = endpoint.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(AppError::InvalidArg(
            "handwriting endpoint must be an http(s) URL".into(),
        ));
    }
    Ok(if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    })
}

fn request_body(model: &str, image: &str) -> Value {
    json!({
        "model": model,
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": PROMPT },
                { "type": "image_url", "image_url": { "url": image } }
            ]
        }]
    })
}

/// The reply text. Servers return `content` as a string or as a list of
/// parts, and reasoning models may lead with a `<think>` block.
fn reply_text(response: &Value) -> AppResult<String> {
    let content = response
        .pointer("/choices/0/message/content")
        .ok_or_else(|| AppError::InvalidArg("model reply has no message".into()))?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        _ => return Err(AppError::InvalidArg("model reply is not text".into())),
    };
    let text = match text.split_once("</think>") {
        Some((_, rest)) => rest,
        None => &text,
    };
    Ok(text.trim().to_string())
}

#[tauri::command]
pub async fn handwriting_recognize(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    image: String,
) -> CommandResult<String> {
    if !image.starts_with(IMAGE_PREFIX) || image.len() > MAX_IMAGE_BYTES {
        return Err(AppError::InvalidArg("handwriting image must be a PNG data URL".into()).into());
    }
    if model.trim().is_empty() {
        return Err(AppError::InvalidArg("handwriting model is not set".into()).into());
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|err| AppError::InvalidArg(format!("handwriting client failed: {err}")))?;
    let mut request = client
        .post(completions_url(&endpoint)?)
        .json(&request_body(model.trim(), &image));
    if let Some(key) = api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|err| AppError::InvalidArg(format!("handwriting request failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::InvalidArg(format!("handwriting server returned {status}")).into());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::InvalidArg(format!("handwriting reply invalid: {err}")))?;
    Ok(reply_text(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completions_url_accepts_base_or_full_path() {
        assert_eq!(
            completions_url(" http://localhost:11434/v1/ ").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            completions_url("https://api.example.com/v1/chat/completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert!(completions_url("localhost:11434").is_err());
    }

    #[test]
    fn reply_text_reads_string_and_part_lists_and_drops_reasoning() {
        let string = json!({ "choices": [{ "message": { "content": " Grüße\nhello \n" } }] });
        assert_eq!(reply_text(&string).unwrap(), "Grüße\nhello");
        let parts = json!({ "choices": [{ "message": { "content": [
            { "type": "text", "text": "Straße " },
            { "type": "text", "text": "street" }
        ] } }] });
        assert_eq!(reply_text(&parts).unwrap(), "Straße street");
        let reasoning =
            json!({ "choices": [{ "message": { "content": "<think>hmm</think>\nMilch" } }] });
        assert_eq!(reply_text(&reasoning).unwrap(), "Milch");
        let empty = json!({ "choices": [{ "message": { "content": null } }] });
        assert_eq!(reply_text(&empty).unwrap(), "");
        assert!(reply_text(&json!({ "error": "busy" })).is_err());
    }

    #[test]
    fn the_command_posts_the_image_with_the_key_and_returns_the_reply() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = Vec::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                head.push(line.trim().to_string());
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let reply = r#"{"choices":[{"message":{"content":"Grüße"}}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            )
            .unwrap();
            (head, serde_json::from_slice::<Value>(&body).unwrap())
        });

        let image = format!("{IMAGE_PREFIX}iVBORw0KGgo=");
        let text = tauri::async_runtime::block_on(handwriting_recognize(
            endpoint,
            " vision ".into(),
            Some("secret".into()),
            image.clone(),
        ))
        .unwrap();

        let (head, body) = server.join().unwrap();
        assert_eq!(text, "Grüße");
        assert_eq!(head[0], "POST /v1/chat/completions HTTP/1.1");
        assert!(
            head.iter()
                .any(|line| line == "authorization: Bearer secret"),
            "{head:?}"
        );
        assert_eq!(body["model"], "vision");
        assert_eq!(
            body.pointer("/messages/0/content/1/image_url/url").unwrap(),
            &json!(image)
        );
    }
}
