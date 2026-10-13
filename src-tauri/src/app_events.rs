use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppEvent {
    CustomWindowDecorationsChanged,
    ImportProgress,
    InvitationsChanged,
    InviteLinkOpened,
    NativeMenuCommand,
    SessionEnded,
    ShowApp,
    SignaturesChanged,
    SyncCompleted,
    SyncUnreachable,
    TrayNoteCreated,
}

impl AppEvent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CustomWindowDecorationsChanged => "custom-window-decorations-changed",
            Self::ImportProgress => "import-progress",
            Self::InvitationsChanged => "invitations-changed",
            Self::InviteLinkOpened => "invite-link-opened",
            Self::NativeMenuCommand => "native-menu-command",
            Self::SessionEnded => "session-ended",
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
                AppEvent::CustomWindowDecorationsChanged,
                "custom-window-decorations-changed",
            ),
            (AppEvent::ImportProgress, "import-progress"),
            (AppEvent::InvitationsChanged, "invitations-changed"),
            (AppEvent::InviteLinkOpened, "invite-link-opened"),
            (AppEvent::NativeMenuCommand, "native-menu-command"),
            (AppEvent::SessionEnded, "session-ended"),
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
