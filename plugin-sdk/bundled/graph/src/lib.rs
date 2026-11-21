//! Shipped Graph plugin: notes, their tags and the links between them, as a
//! graph in a tab and around the open note in the sidebar.
//!
//! The plugin picks the notes, tags and colour groups from metadata; the host
//! adds the links between notes from bodies the plugin never sees, and draws
//! the graph. The host keeps `state` (`{ local, focus? }`) between calls; this
//! plugin holds nothing.
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

/// Where a view is drawn: the sidebar follows the open note, the tab shows
/// the whole vault. Both can be narrowed to a clicked tag.
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

    /// Following the open note. The sidebar starts out doing so.
    fn local(&self, place: Place) -> bool {
        self.state()["local"]
            .as_bool()
            .unwrap_or(place == Place::Sidebar)
    }

    fn depth(&self) -> u64 {
        let depth = self.setting("depth");
        depth
            .as_u64()
            .or_else(|| depth.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(DEFAULT_DEPTH)
            .clamp(1, MAX_DEPTH)
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
        let local = self.local(place);
        let focus = self.focus();
        let active = self.input["activeNoteId"].as_str();
        let all = host(notes::all())?;
        let tags = self.setting("tags").as_bool() != Some(false);

        let mut nodes = Vec::with_capacity(all.len());
        let mut links = Vec::new();
        let mut tag_names = BTreeSet::new();
        for note in &all {
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

        let mut children = Vec::new();
        if focus.is_some() || place == Place::Sidebar {
            let narrowed = focus.is_some() || local;
            children.push(json!({
                "type": "button",
                "label": { "key": if narrowed { "view.showVault" } else { "view.showLocal" } },
                "on": { "event": "toggle" },
            }));
        }
        if focus.is_none() && local && active.is_none() {
            children.push(json!({
                "type": "text",
                "tone": "muted",
                "text": { "key": "view.noActiveNote" },
            }));
        }
        let mut graph = json!({
            "type": "graph",
            "nodes": nodes,
            "links": links,
            "depth": self.depth(),
            "orphans": self.setting("orphans").as_bool() != Some(false),
            "onSelect": "open",
        });
        if let Some(focus) = focus {
            graph["focus"] = json!(focus);
        } else if local {
            graph["focus"] = json!(active.unwrap_or_default());
        }
        children.push(graph);

        Ok(json!({
            "state": self.next_state(local, focus),
            "view": { "type": "stack", "children": children },
        }))
    }

    fn next_state(&self, local: bool, focus: Option<&str>) -> Value {
        match focus {
            Some(focus) => json!({ "local": local, "focus": focus }),
            None => json!({ "local": local }),
        }
    }

    fn on_event(&self) -> Result<Value, String> {
        let value = self.input["value"].as_str().unwrap_or_default();
        // `render` runs before any event, and always stores `local`.
        let local = self.state()["local"].as_bool().unwrap_or(false);
        let state = |focus| self.next_state(local, focus);
        match self.input["event"].as_str().unwrap_or_default() {
            // Leaving a tag goes back to where the view was; otherwise the
            // view switches between the open note and the whole vault.
            "toggle" => Ok(json!({
                "state": match self.focus() {
                    Some(_) => state(None),
                    None => self.next_state(!local, None),
                },
            })),
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
