use serde_json::{json, Value};

wit_bindgen::generate!({ path: "wit", world: "mindstream:plugin/plugin" });

struct Hello;

impl Guest for Hello {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let _: Value = serde_json::from_str(&input).map_err(|error| error.to_string())?;
        match export.as_str() {
            "$exports" => Ok(json!(["hello"]).to_string()),
            "hello" => {
                mindstream::plugin::runtime::log(mindstream::plugin::runtime::LogLevel::Info, "Hello from Rust");
                Ok(json!({ "effect": "toast", "message": "Hello from Rust" }).to_string())
            }
            _ => Err(format!("unknown export {export}")),
        }
    }
}

export!(Hello);
