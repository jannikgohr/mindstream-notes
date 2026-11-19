//! Shipped Journal plugin: daily notes and a calendar of the notes on each day.
//!
//! A daily note is the note titled with the day, in the title format, directly
//! inside the journal folder. Days are local `YYYY-MM-DD` strings; the host
//! clock turns them into titles and buckets notes by their local day.
use serde_json::{json, Value};
use std::collections::HashMap;

mod view;

wit_bindgen::generate!({ path: "../../wit", world: "mindstream:plugin/plugin" });
use mindstream::plugin::clock::{self, TimeUnit};
use mindstream::plugin::notes;
use mindstream::plugin::types::NoteMeta;

const DEFAULT_TITLE_FORMAT: &str = "YYYY-MM-DD";
const MAX_DAYS: u64 = 62;

fn host<T>(result: Result<T, mindstream::plugin::types::Error>) -> Result<T, String> {
    result.map_err(|e| format!("{e:?}"))
}

/// `YYYY-MM-DD`, checked by shape; the host clock rejects impossible dates.
fn day(value: &Value, field: &str) -> Result<String, String> {
    let s = value.as_str().unwrap_or_default();
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if ok {
        Ok(s.to_string())
    } else {
        Err(format!("{field} must be a YYYY-MM-DD date"))
    }
}

/// The UTC offset at the end of an RFC 3339 timestamp, or `Z`.
fn offset(timestamp: &str) -> &str {
    let tail = timestamp.len().saturating_sub(6);
    match timestamp.get(tail..) {
        Some(o) if o.starts_with(['+', '-']) && o.as_bytes()[3] == b':' => o,
        _ => "Z",
    }
}

struct Journal<'a> {
    input: &'a Value,
    /// Noon keeps a day's timestamp inside that day through any DST shift.
    noon_offset: String,
}

impl<'a> Journal<'a> {
    fn new(input: &'a Value) -> Self {
        let now = clock::now();
        Journal {
            input,
            noon_offset: offset(&now).to_string(),
        }
    }

    fn setting(&self, id: &str) -> Option<&str> {
        self.input["settings"][id]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    fn folder(&self) -> Option<&str> {
        self.setting("folder")
    }

    fn noon(&self, day: &str) -> String {
        format!("{day}T12:00:00{}", self.noon_offset)
    }

    fn title(&self, timestamp: &str) -> Result<String, String> {
        let format = self.setting("title-format").unwrap_or(DEFAULT_TITLE_FORMAT);
        host(clock::format(
            timestamp,
            format,
            self.input["locale"].as_str(),
        ))
    }

    fn today(&self) -> Result<String, String> {
        host(clock::format(&clock::now(), "YYYY-MM-DD", None))
    }

    fn open_day(&self, day: &str) -> Result<Value, String> {
        let title = self.title(&self.noon(day))?;
        let mut effect = json!({
            "effect": "openOrCreateNote",
            "title": title,
            "parentId": self.folder(),
        });
        if let Some(template) = self.setting("template") {
            effect["template"] = json!({ "sourceNoteId": template, "date": day });
        }
        Ok(effect)
    }

    fn days(&self) -> Result<Value, String> {
        let from = day(&self.input["from"], "from")?;
        let selected = day(&self.input["selected"], "selected")?;
        let count = self.input["count"].as_u64().unwrap_or(42);
        self.days_for(&from, count, &selected)
    }

    /// Marks for `count` days from `from`, and the notes on `selected`.
    fn days_for(&self, from: &str, count: u64, selected: &str) -> Result<Value, String> {
        let count = count.min(MAX_DAYS);
        let notes = host(notes::all())?;

        let folder = self.folder();
        let mut daily: HashMap<&str, usize> = HashMap::new();
        for (i, note) in notes.iter().enumerate() {
            if note.folder_id.as_deref() == folder {
                daily.entry(note.title.as_str()).or_insert(i);
            }
        }
        let mut by_day: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, note) in notes.iter().enumerate() {
            let created = host(clock::format(&note.created, "YYYY-MM-DD", None))?;
            let modified = host(clock::format(&note.modified, "YYYY-MM-DD", None))?;
            by_day.entry(created.clone()).or_default().push(i);
            if modified != created {
                by_day.entry(modified).or_default().push(i);
            }
        }
        let on_day = |key: &str, daily: Option<usize>| -> Vec<usize> {
            by_day
                .get(key)
                .into_iter()
                .flatten()
                .copied()
                .filter(|&i| Some(i) != daily)
                .collect()
        };

        let start = self.noon(from);
        let mut days = Vec::new();
        for i in 0..count {
            let timestamp = host(clock::add(&start, i as i64, TimeUnit::Day))?;
            let key = host(clock::format(&timestamp, "YYYY-MM-DD", None))?;
            let note = daily.get(self.title(&timestamp)?.as_str()).copied();
            days.push(json!({
                "date": key,
                "daily": note.is_some(),
                "notes": on_day(&key, note).len(),
            }));
        }

        let note = daily
            .get(self.title(&self.noon(selected))?.as_str())
            .copied();
        let mut others = on_day(selected, note);
        others.sort_by(|&a, &b| notes[b].modified.cmp(&notes[a].modified));
        Ok(json!({
            "days": days,
            "selected": {
                "date": selected,
                "daily": note.map(|i| summary(&notes[i])),
                "notes": others.iter().map(|&i| summary(&notes[i])).collect::<Vec<_>>(),
            },
        }))
    }
}

fn summary(note: &NoteMeta) -> Value {
    let folder = note.folder_path.rsplit(" / ").next().unwrap_or_default();
    json!({
        "id": note.id,
        "title": note.title,
        "kind": note.kind,
        "folder": folder,
    })
}

struct Plugin;
impl Guest for Plugin {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let journal = Journal::new(&input);
        let output = match export.as_str() {
            "$exports" => json!(["days", "openDay", "openToday", "render", "onEvent"]),
            "days" => journal.days()?,
            "render" => journal.render()?,
            "onEvent" => journal.on_event()?,
            "openDay" => journal.open_day(&day(&input["date"], "date")?)?,
            "openToday" => journal.open_day(&journal.today()?)?,
            _ => return Err(format!("unknown export {export}")),
        };
        Ok(output.to_string())
    }
}
export!(Plugin);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_must_be_iso_dates() {
        assert_eq!(day(&json!("2026-11-23"), "d").unwrap(), "2026-11-23");
        for bad in [
            json!("2026-1-23"),
            json!("2026/11/23"),
            json!(20261123),
            json!(null),
        ] {
            assert!(day(&bad, "d").is_err(), "{bad}");
        }
    }

    #[test]
    fn offset_reads_the_timestamp_suffix() {
        assert_eq!(offset("2026-11-23T08:00:00.123+01:00"), "+01:00");
        assert_eq!(offset("2026-11-23T08:00:00-05:30"), "-05:30");
        assert_eq!(offset("2026-11-23T08:00:00Z"), "Z");
        assert_eq!(offset(""), "Z");
    }
}
