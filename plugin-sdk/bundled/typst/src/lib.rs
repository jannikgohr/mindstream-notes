//! Shipped Typst integration. Native compilation is an optional host capability.
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../../wit", world: "mindstream:plugin/plugin" });
use mindstream::plugin::{native_tools, runtime};

fn ascii_space(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ')
}

// JavaScript's \s also includes BOM, but excludes the Unicode NEL character.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn diagnostics(stderr: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for raw in stderr.split('\n') {
        let line = raw.trim_end_matches(ascii_space);
        if line.is_empty() {
            continue;
        }
        let start = line
            .strip_prefix("error:")
            .map(|message| ("error", message))
            .or_else(|| {
                line.strip_prefix("warning:")
                    .map(|message| ("warning", message))
            })
            .map(|(severity, message)| (severity, message.trim_start_matches(js_space)))
            // The reference JS regex has no dot-all/multiline flag.
            .filter(|(_, message)| !message.contains(['\r', '\n', '\u{2028}', '\u{2029}']));
        if let Some((severity, message)) = start {
            out.push(json!({"severity": severity, "message": message}));
        } else if let Some(previous) = out.last_mut() {
            let message = previous["message"].as_str().unwrap_or_default();
            previous["message"] = json!(format!("{message}\n{line}"));
        } else {
            out.push(json!({"severity": "error", "message": line}));
        }
    }
    out
}

fn render(input: &Value) -> Result<Value, String> {
    if !runtime::has_permission("nativeTools.runDeclared")
        || !native_tools::available("typst").map_err(|e| format!("{e:?}"))?
    {
        return Ok(json!({"sourceOnly": true, "diagnostics": []}));
    }
    let result = native_tools::run(
        "typst",
        &native_tools::RunOptions {
            args: ["compile", "--format", "pdf", "-", "-"]
                .into_iter()
                .map(String::from)
                .collect(),
            stdin: Some(input["body"].as_str().unwrap_or_default().into()),
            timeout_ms: Some(30_000),
            output_base64: true,
        },
    )
    .map_err(|e| format!("{e:?}"))?;
    Ok(if result.timed_out {
        json!({
            "preview": {"mime": "application/pdf", "dataBase64": ""},
            "diagnostics": [{"severity": "error", "message": "Typst timed out while compiling."}]
        })
    } else {
        json!({
            "preview": {
                "mime": "application/pdf",
                "dataBase64": if result.status_code == Some(0) { result.stdout_base64.unwrap_or_default() } else { String::new() }
            },
            "diagnostics": diagnostics(&result.stderr)
        })
    })
}

struct Typst;
impl Guest for Typst {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let output = match export.as_str() {
            "$exports" => json!(["renderDocument", "exportDocument"]),
            "renderDocument" | "exportDocument" => render(&input)?,
            _ => return Err(format!("unknown export {export}")),
        };
        Ok(output.to_string())
    }
}
export!(Typst);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_groups_multiline_diagnostics_and_preserves_leading_context() {
        assert_eq!(
            diagnostics(
                "preamble \r\nwarning:\tcareful \n  context\n\nerror:\u{a0}broken\n  at line 1\n"
            ),
            vec![
                json!({"severity":"error","message":"preamble"}),
                json!({"severity":"warning","message":"careful\n  context"}),
                json!({"severity":"error","message":"broken\n  at line 1"}),
            ]
        );
        assert!(diagnostics(" \t\r\n").is_empty());
        assert_eq!(
            diagnostics("error: x\u{2028}\nwarning:\u{2028}valid\nerror: x\ry"),
            vec![
                json!({"severity":"error","message":"error: x\u{2028}"}),
                json!({"severity":"warning","message":"valid\nerror: x\ry"}),
            ]
        );
    }
}
