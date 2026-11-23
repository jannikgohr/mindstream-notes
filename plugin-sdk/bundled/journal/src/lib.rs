//! Shipped Journal plugin: daily notes and a calendar of the notes on each day.
//!
//! A daily note is the note titled with the day, in the title format, directly
//! inside the journal folder, and shows only on its own day. Other notes show
//! on the day they were created and the day they were last edited. Days are
//! local `YYYY-MM-DD` strings; the host clock turns them into titles, and the
//! host's note queries bucket and count notes by their local day, so a render
//! costs the same however many notes share a day.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

mod view;

wit_bindgen::generate!({ path: "../../wit", world: "mindstream:plugin/plugin" });
use mindstream::plugin::clock::{self, TimeUnit};
use mindstream::plugin::notes;
use mindstream::plugin::types::NoteMeta;

const DEFAULT_TITLE_FORMAT: &str = "YYYY-MM-DD";
const MAX_DAYS: u64 = 62;
/// Notes listed for the selected day, besides its daily note.
const MAX_LISTED: usize = 100;

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

    /// Marks for `count` days from `from`, and the notes on `selected`.
    fn days_for(&self, from: &str, count: u64, selected: &str) -> Result<Value, String> {
        let count = count.min(MAX_DAYS);
        let start = self.noon(from);
        let mut shown = Vec::new();
        for i in 0..count {
            let timestamp = host(clock::add(&start, i as i64, TimeUnit::Day))?;
            let key = host(clock::format(&timestamp, "YYYY-MM-DD", None))?;
            shown.push((key, self.title(&timestamp)?));
        }
        let last = shown.last().map(|(key, _)| key.clone()).unwrap_or_default();
        let selected_title = self.title(&self.noon(selected))?;

        let mut titles: Vec<String> = shown.iter().map(|(_, title)| title.clone()).collect();
        titles.push(selected_title.clone());
        let journal = host(notes::query(&notes::NoteQuery {
            folder: Some(match self.folder() {
                Some(id) => notes::FolderScope::Folder(id.into()),
                None => notes::FolderScope::Root,
            }),
            days: None,
            titles: Some(titles),
            limit: None,
        }))?;
        let mut daily: HashMap<&str, &notes::DatedNote> = HashMap::new();
        for note in &journal {
            daily.entry(note.note.title.as_str()).or_insert(note);
        }

        // A daily note is not one of the other notes on the days it was
        // created or edited, its own included.
        let others = |first: &str, last: &str| -> Result<HashMap<String, u32>, String> {
            let mut counts: HashMap<String, u32> = host(notes::count_by_day(&notes::DayRange {
                first: first.into(),
                last: last.into(),
            }))?
            .into_iter()
            .map(|c| (c.day, c.notes))
            .collect();
            for note in daily.values() {
                for day in dated_days(note) {
                    if let Some(count) = counts.get_mut(day) {
                        *count = count.saturating_sub(1);
                    }
                }
            }
            Ok(counts)
        };
        let counts = others(from, &last)?;

        let mut days = Vec::new();
        for (key, title) in &shown {
            days.push(json!({
                "date": key,
                "daily": daily.contains_key(title.as_str()),
                "notes": counts.get(key).copied().unwrap_or(0),
            }));
        }

        let total = if (from..=last.as_str()).contains(&selected) {
            counts.get(selected).copied()
        } else {
            others(selected, selected)?.get(selected).copied()
        }
        .unwrap_or(0) as usize;
        let excluded: HashSet<&str> = daily.values().map(|d| d.note.id.as_str()).collect();
        let listed: Vec<Value> = host(notes::query(&notes::NoteQuery {
            folder: None,
            days: Some(notes::DayRange {
                first: selected.into(),
                last: selected.into(),
            }),
            titles: None,
            limit: Some((MAX_LISTED + excluded.len()) as u32),
        }))?
        .iter()
        .filter(|d| !excluded.contains(d.note.id.as_str()))
        .take(MAX_LISTED)
        .map(|d| {
            let mut row = summary(&d.note);
            row["edited"] = json!(d.created_day != selected);
            row
        })
        .collect();
        Ok(json!({
            "days": days,
            "selected": {
                "date": selected,
                "daily": daily.get(selected_title.as_str()).map(|d| summary(&d.note)),
                "more": total.saturating_sub(listed.len()),
                "notes": listed,
            },
        }))
    }
}

/// The days a note was created and last edited, each once.
fn dated_days(note: &notes::DatedNote) -> impl Iterator<Item = &str> {
    let created = note.created_day.as_str();
    let modified = note.modified_day.as_str();
    std::iter::once(created).chain((modified != created).then_some(modified))
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
            "$exports" => json!(["openToday", "render", "onEvent"]),
            "render" => journal.render()?,
            "onEvent" => journal.on_event()?,
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
