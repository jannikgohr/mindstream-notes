use base64::Engine;
use serde_json::Value;

use super::ink_pages;

/// Notes written by the TypeScript editor; see the test that regenerates
/// this fixture in src/lib/ink/document.test.ts.
const FIXTURE: &str = include_str!("ink_pages_fixture.json");

fn described(note: &Value) -> Value {
    let state = base64::engine::general_purpose::STANDARD
        .decode(note["state"].as_str().unwrap())
        .unwrap();
    let pages = ink_pages(&state)
        .into_iter()
        .map(|page| {
            serde_json::json!({
                "id": page.id,
                "strokes": page.strokes.iter().map(|stroke| serde_json::json!({
                    "color": stroke.color,
                    "width": stroke.width,
                    "points": stroke.points.iter()
                        .map(|p| [p.x, p.y, p.pressure])
                        .collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    Value::Array(pages)
}

/// JSON from TypeScript writes `100` where Rust writes `100.0`.
fn as_floats(value: &Value) -> Value {
    match value {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(as_floats).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), as_floats(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn reads_the_pages_and_strokes_the_editor_wrote() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for name in ["paged", "legacy"] {
        let pages = described(&fixture[name]);
        assert_eq!(
            as_floats(&pages),
            as_floats(&fixture[name]["pages"]),
            "{name}"
        );
    }
}
