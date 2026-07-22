use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppEvent {
    CollabCredentialsChanged,
    CustomWindowDecorationsChanged,
    NativeMenuCommand,
    ShowApp,
    SignaturesChanged,
    SyncCompleted,
    SyncUnreachable,
    TrayNoteCreated,
}

impl AppEvent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CollabCredentialsChanged => "collab-credentials-changed",
            Self::CustomWindowDecorationsChanged => "custom-window-decorations-changed",
            Self::NativeMenuCommand => "native-menu-command",
            Self::ShowApp => "show-app",
            Self::SignaturesChanged => "signatures-changed",
            Self::SyncCompleted => "sync-completed",
            Self::SyncUnreachable => "sync-unreachable",
            Self::TrayNoteCreated => "tray-note-created",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppEvent;

    #[test]
    fn event_names_match_tauri_wire_names() {
        let cases = [
            (
                AppEvent::CollabCredentialsChanged,
                "collab-credentials-changed",
            ),
            (
                AppEvent::CustomWindowDecorationsChanged,
                "custom-window-decorations-changed",
            ),
            (AppEvent::NativeMenuCommand, "native-menu-command"),
            (AppEvent::ShowApp, "show-app"),
            (AppEvent::SignaturesChanged, "signatures-changed"),
            (AppEvent::SyncCompleted, "sync-completed"),
            (AppEvent::SyncUnreachable, "sync-unreachable"),
            (AppEvent::TrayNoteCreated, "tray-note-created"),
        ];

        for (event, expected) in cases {
            assert_eq!(event.as_str(), expected);
        }
    }
}
