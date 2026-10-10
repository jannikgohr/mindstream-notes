//! Classification of a verified legacy export. Workers never replay its entire
//! contents into localStorage or expose unopened accounts through settings IPC.
use crate::browser_archive::{Snapshot, Values};

pub struct Source(pub Snapshot);

impl Source {
    pub fn raw(&self, key: &str) -> Option<&str> {
        self.0.values.get(key).map(String::as_str)
    }

    pub fn vault_settings(&self, vault_id: &str) -> Option<&str> {
        self.raw(&format!("notes-app:settings:v1:vault:{vault_id}"))
    }

    pub fn layout(&self, vault_id: &str) -> Option<&str> {
        self.raw(&format!(
            "notes-app:dock-layout:v1:vault:{}",
            encode_component(vault_id)
        ))
        .or_else(|| {
            (vault_id == "default")
                .then(|| self.raw("notes-app:dock-layout:v1"))
                .flatten()
        })
    }

    pub fn had_existing_data(&self) -> bool {
        self.0.values.keys().any(|key| {
            key.starts_with("notes-app:") && key != "notes-app:file-tree-create-toolbar:v1"
        })
    }

    pub fn signing_raw(&self, server: &str, username: &str) -> Option<&str> {
        signing_raw(&self.0.values, server, username)
    }
}

pub(crate) fn signing_raw<'a>(values: &'a Values, server: &str, username: &str) -> Option<&'a str> {
    values
        .get(&format!(
            "mindstream:collab-signing-key:v1:{}:{}",
            encode_component(server),
            encode_component(username)
        ))
        .map(String::as_str)
}

// Match the legacy JS encodeURIComponent exactly, including its unescaped
// punctuation and UTF-8 bytes. '+' never stands for a space in these keys.
fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_accounts_and_vaults_get_only_their_exact_raw_sources() {
        let values = Values::from([
            (
                "notes-app:settings:v1:vault:work".into(),
                "malformed work settings".into(),
            ),
            (
                "notes-app:settings:v1".into(),
                "default and device values".into(),
            ),
            (
                "notes-app:dock-layout:v1".into(),
                "legacy default layout".into(),
            ),
            (
                "notes-app:dock-layout:v1:vault:work".into(),
                "work layout".into(),
            ),
            (
                "mindstream:collab-signing-key:v1:https%3A%2F%2Fone.example%2F:alice%2B%C3%A9"
                    .into(),
                "synthetic private value".into(),
            ),
            ("unknown.plugin.key".into(), "opaque raw value".into()),
        ]);
        // Construct only through deserialization, like the decrypted archive.
        let source = Source(
            serde_json::from_value(serde_json::json!({
                "origin": "http://localhost:1420", "vaultId": "work",
                "values": values, "checksum": "test"
            }))
            .unwrap(),
        );
        assert_eq!(
            source.vault_settings("work"),
            Some("malformed work settings")
        );
        assert!(source.vault_settings("new").is_none());
        assert_eq!(source.layout("work"), Some("work layout"));
        assert_eq!(source.layout("default"), Some("legacy default layout"));
        assert!(source.layout("new").is_none());
        assert_eq!(
            source.signing_raw("https://one.example/", "alice+é"),
            Some("synthetic private value")
        );
        assert!(source
            .signing_raw("https://two.example/", "alice+é")
            .is_none());
        assert!(source
            .signing_raw("https://one.example/", "alice é")
            .is_none());
        assert_eq!(source.raw("unknown.plugin.key"), Some("opaque raw value"));
    }
}
