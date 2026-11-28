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

fn note_with_stroke_at(y: f32, schema: Option<f64>) -> Vec<u8> {
    use yrs::{Array, Map, MapPrelim, Transact};
    let mut payload = vec![2];
    payload.extend(0xff00_0000u32.to_le_bytes());
    payload.extend(4f32.to_le_bytes());
    payload.extend(1u32.to_le_bytes());
    payload.extend(10f32.to_le_bytes());
    payload.extend(y.to_le_bytes());
    payload.extend(1f32.to_le_bytes());
    let doc = yrs::Doc::new();
    let strokes = doc.get_or_insert_array("strokes");
    let meta = doc.get_or_insert_map("ink:meta");
    {
        let mut txn = doc.transact_mut();
        strokes.push_back(
            &mut txn,
            MapPrelim::from([
                ("id".to_string(), yrs::Any::from("s")),
                ("tombstoned".to_string(), yrs::Any::from(false)),
                ("payload".to_string(), yrs::Any::from(payload)),
            ]),
        );
        if let Some(schema) = schema {
            meta.insert(&mut txn, "schema", schema);
        }
    }
    super::encode_state(&doc)
}

#[test]
fn a_stroke_far_below_old_pages_does_not_ask_for_millions_of_them() {
    for y in [1e9, 1e25, f32::MAX] {
        assert_eq!(ink_pages(&note_with_stroke_at(y, None)).len(), 1002, "{y}");
    }
}

#[test]
fn a_note_from_a_newer_editor_has_no_pages() {
    assert_eq!(ink_pages(&note_with_stroke_at(10.0, Some(2.0))).len(), 2);
    assert!(ink_pages(&note_with_stroke_at(10.0, Some(3.0))).is_empty());
}
