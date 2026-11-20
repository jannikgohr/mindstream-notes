//! The `schema` sidebar view: the calendar as a tree of host components.
//!
//! The host keeps `state` (`{ month, selected }`) between calls and passes it
//! back in; this plugin holds nothing.
use super::{day, host, Journal};
use crate::mindstream::plugin::clock;
use serde_json::{json, Value};

const CALENDAR_ICON: &str = "icons/calendar.svg";
const MAX_DOTS: u64 = 3;

struct State {
    month: String,
    selected: String,
}

impl Journal<'_> {
    fn state(&self) -> Result<State, String> {
        let state = &self.input["state"];
        let selected = match day(&state["selected"], "selected") {
            Ok(selected) => selected,
            Err(_) => self.today()?,
        };
        let month = state["month"]
            .as_str()
            .filter(|m| day(&json!(format!("{m}-01")), "month").is_ok())
            .map_or_else(|| selected[..7].to_string(), str::to_string);
        Ok(State { month, selected })
    }

    pub(crate) fn render(&self) -> Result<Value, String> {
        let state = self.state()?;
        // A week either side of the month covers the grid whichever day the
        // host starts its weeks on.
        let first = self.noon(&format!("{}-01", state.month));
        let from = host(clock::add(&first, -7, clock::TimeUnit::Day))?;
        let from = host(clock::format(&from, "YYYY-MM-DD", None))?;
        let data = self.days_for(&from, 49, &state.selected)?;

        let mut days = serde_json::Map::new();
        for d in data["days"].as_array().into_iter().flatten() {
            let daily = d["daily"].as_bool() == Some(true);
            let notes = d["notes"].as_u64().unwrap_or(0);
            if !daily && notes == 0 {
                continue;
            }
            let mut marks = Vec::new();
            if daily {
                marks.push("accent");
            }
            marks.extend(std::iter::repeat_n("muted", notes.min(MAX_DOTS) as usize));
            let title = (notes > 0).then(|| json!({ "key": "view.notes", "count": notes }));
            days.insert(
                d["date"].as_str().unwrap_or_default().to_string(),
                json!({ "marks": marks, "strong": daily, "title": title }),
            );
        }

        let selected = &data["selected"];
        let mut items = Vec::new();
        match selected["daily"].as_object() {
            Some(daily) => items.push(json!({
                "label": daily["title"],
                "icon": CALENDAR_ICON,
                "tone": "accent",
                "on": { "effect": "openNote", "noteId": daily["id"] },
            })),
            None => items.push(json!({
                "label": { "key": "view.createDailyNote" },
                "icon": CALENDAR_ICON,
                "tone": "muted",
                "on": { "event": "open", "value": state.selected },
            })),
        }
        for note in selected["notes"].as_array().into_iter().flatten() {
            items.push(json!({
                "label": note["title"],
                "noteKind": note["kind"],
                "detail": note["folder"],
                "on": { "effect": "openNote", "noteId": note["id"], "preview": true },
            }));
        }

        let heading = json!({
            "date": state.selected,
            "format": { "weekday": "long", "month": "long", "day": "numeric" },
        });
        Ok(json!({
            "state": { "month": state.month, "selected": state.selected },
            "view": {
                "type": "stack",
                "children": [
                    {
                        "type": "calendar",
                        "month": state.month,
                        "selected": state.selected,
                        "days": days,
                        "onSelect": "select",
                        "onMonth": "month",
                    },
                    { "type": "heading", "text": heading },
                    { "type": "list", "items": items },
                ],
            },
        }))
    }

    pub(crate) fn on_event(&self) -> Result<Value, String> {
        let mut state = self.state()?;
        let value = &self.input["value"];
        let open = match self.input["event"].as_str().unwrap_or_default() {
            "select" | "open" => Some(day(value, "value")?),
            "today" => Some(self.today()?),
            "month" => {
                let month = value.as_str().unwrap_or_default();
                day(&json!(format!("{month}-01")), "value")?;
                state.month = month.to_string();
                None
            }
            other => return Err(format!("unknown event {other}")),
        };
        let effect = match open {
            Some(date) => {
                state.month = date[..7].to_string();
                state.selected = date.clone();
                Some(self.open_day(&date)?)
            }
            None => None,
        };
        Ok(json!({
            "state": { "month": state.month, "selected": state.selected },
            "effect": effect,
        }))
    }
}
