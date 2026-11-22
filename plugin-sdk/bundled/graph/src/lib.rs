//! Shipped Graph plugin: notes, their tags and the links between them, as a
//! graph in a tab and around the open note in the sidebar.
//!
//! The plugin picks the notes, tags and colour groups from metadata; the host
//! adds the links between notes from bodies the plugin never sees, and draws
//! the graph. The host keeps `state` (`{ focus? }`) between calls; this plugin
//! holds nothing.
use serde_json::{json, Value};
use std::collections::BTreeSet;

wit_bindgen::generate!({ path: "../../wit", world: "mindstream:plugin/plugin" });
use mindstream::plugin::notes;
use mindstream::plugin::types::NoteMeta;

const DEFAULT_DEPTH: u64 = 1;
const MAX_DEPTH: u64 = 5;
const TAG_PREFIX: &str = "tag:";
const TAB_VIEW: &str = "graph";

fn host<T>(result: Result<T, mindstream::plugin::types::Error>) -> Result<T, String> {
    result.map_err(|e| format!("{e:?}"))
}

/// Where a view is drawn: the sidebar shows what is near the open note, the
/// tab the whole vault. Both can be narrowed to a clicked tag.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    Sidebar,
    Tab,
}

struct Graph<'a> {
    input: &'a Value,
}

impl Graph<'_> {
    fn setting(&self, id: &str) -> &Value {
        &self.input["settings"][id]
    }

    fn state(&self) -> &Value {
        &self.input["state"]
    }

    /// A node the view is narrowed to: a clicked tag.
    fn focus(&self) -> Option<&str> {
        self.state()["focus"].as_str()
    }

    fn depth(&self) -> u64 {
        let depth = self.setting("depth");
        depth
            .as_u64()
            .or_else(|| depth.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(DEFAULT_DEPTH)
            .clamp(1, MAX_DEPTH)
    }

    /// A slider's value as a share of its usual 100.
    fn share(&self, id: &str) -> f64 {
        let value = self.setting(id);
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(100.0)
            / 100.0
    }

    /// Whether the search setting, if any, finds the note: in its title, its
    /// folders or a tag.
    fn found(&self, note: &NoteMeta, search: &str) -> bool {
        search.is_empty()
            || [&note.title, &note.folder_path]
                .into_iter()
                .chain(&note.tags)
                .any(|text| text.to_lowercase().contains(search))
    }

    fn group(&self, note: &NoteMeta) -> Option<String> {
        match self.setting("color-by").as_str().unwrap_or("folder") {
            "folder" => note
                .folder_path
                .split(" / ")
                .next()
                .filter(|f| !f.is_empty())
                .map(str::to_string),
            "tag" => note.tags.iter().min().cloned(),
            _ => None,
        }
    }

    fn render(&self, place: Place) -> Result<Value, String> {
        let local = place == Place::Sidebar;
        let focus = self.focus();
        // The sidebar draws around the open note or a clicked tag.
        let centre = match (focus, place) {
            (Some(focus), _) => Some(focus),
            (None, Place::Sidebar) => match self.input["activeNoteId"].as_str() {
                Some(active) => Some(active),
                // Nothing to draw around, so no need to read the vault.
                None => {
                    return Ok(json!({
                        "state": state(None),
                        "view": {
                            "type": "text",
                            "tone": "muted",
                            "text": { "key": "view.noActiveNote" },
                        },
                    }))
                }
            },
            (None, Place::Tab) => None,
        };
        let all = host(notes::all())?;
        let tags = self.setting("tags").as_bool() != Some(false);
        let search = self
            .setting("search")
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();

        let mut nodes = Vec::with_capacity(all.len());
        let mut links = Vec::new();
        let mut tag_names = BTreeSet::new();
        for note in &all {
            // The note a local graph is drawn around always shows.
            if !self.found(note, &search) && centre != Some(note.id.as_str()) {
                continue;
            }
            nodes.push(match self.group(note) {
                Some(group) => json!({ "id": note.id, "group": group }),
                None => json!({ "id": note.id }),
            });
            if tags {
                for tag in &note.tags {
                    links.push(json!([note.id, format!("{TAG_PREFIX}{tag}")]));
                    tag_names.insert(tag.as_str());
                }
            }
        }
        for tag in tag_names {
            nodes.push(json!({ "id": format!("{TAG_PREFIX}{tag}"), "label": format!("#{tag}") }));
        }

        let mut graph = json!({
            "type": "graph",
            "nodes": nodes,
            "links": links,
            "depth": self.depth(),
            "orphans": self.setting("orphans").as_bool() != Some(false),
            "directions": self.setting("directions").as_bool() != Some(false),
            "forces": {
                "centre": self.share("center-force"),
                "repel": self.share("repel-force"),
                "link": self.share("link-force"),
                "linkDistance": self.share("link-distance") * 40.0,
            },
            "onSelect": "open",
        });
        if let Some(centre) = centre {
            graph["focus"] = json!(centre);
        }
        // A clicked tag narrows the view; this leads back out of it.
        if focus.is_some() {
            graph["action"] = json!({
                "label": { "key": if local { "view.showLocal" } else { "view.showVault" } },
                "on": { "event": "unfocus" },
            });
        }

        Ok(json!({
            "state": state(focus),
            "view": { "type": "stack", "children": [graph] },
        }))
    }

    fn on_event(&self) -> Result<Value, String> {
        let value = self.input["value"].as_str().unwrap_or_default();
        match self.input["event"].as_str().unwrap_or_default() {
            "unfocus" => Ok(json!({ "state": state(None) })),
            "open" if value.starts_with(TAG_PREFIX) => Ok(json!({ "state": state(Some(value)) })),
            "open" => {
                let note = host(notes::get(value))?.ok_or("no such note")?;
                Ok(json!({
                    "state": state(self.focus()),
                    "effect": { "effect": "openNote", "noteId": note.id, "preview": true },
                }))
            }
            "open-graph" => Ok(json!({ "state": state(self.focus()), "effect": open_tab() })),
            other => Err(format!("unknown event {other}")),
        }
    }
}

fn state(focus: Option<&str>) -> Value {
    match focus {
        Some(focus) => json!({ "focus": focus }),
        None => json!({}),
    }
}

fn open_tab() -> Value {
    json!({ "effect": "openTabView", "viewId": TAB_VIEW })
}

struct Plugin;
impl Guest for Plugin {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let graph = Graph { input: &input };
        let output = match export.as_str() {
            "$exports" => json!(["render", "renderTab", "onEvent", "openGraph"]),
            "render" => graph.render(Place::Sidebar)?,
            "renderTab" => graph.render(Place::Tab)?,
            "onEvent" => graph.on_event()?,
            "openGraph" => open_tab(),
            _ => return Err(format!("unknown export {export}")),
        };
        Ok(output.to_string())
    }
}
export!(Plugin);
