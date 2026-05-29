use std::{collections::HashMap, sync::LazyLock};

use serde::Deserialize;

include!(concat!(env!("OUT_DIR"), "/i18n_bundles.rs"));

const FALLBACK_LANGUAGE: &str = "en";

#[derive(Debug, Default, Deserialize)]
struct I18nBundle {
    #[serde(default)]
    ui: HashMap<String, String>,
}

static BUNDLES: LazyLock<HashMap<&'static str, I18nBundle>> = LazyLock::new(|| {
    let mut bundles = HashMap::new();
    for (code, raw) in I18N_BUNDLES {
        match serde_json::from_str::<I18nBundle>(raw) {
            Ok(bundle) => {
                bundles.insert(*code, bundle);
            }
            Err(err) => {
                log::warn!("[i18n] failed to parse {code}.json for Rust strings: {err}");
            }
        }
    }
    bundles
});

pub fn normalize_language_code(value: &str) -> &'static str {
    if let Some((code, _)) = BUNDLES.get_key_value(value) {
        return code;
    }
    FALLBACK_LANGUAGE
}

pub fn t_ui(language_code: &str, key: &str) -> String {
    let code = normalize_language_code(language_code);
    BUNDLES
        .get(code)
        .and_then(|bundle| bundle.ui.get(key))
        .or_else(|| {
            BUNDLES
                .get(FALLBACK_LANGUAGE)
                .and_then(|bundle| bundle.ui.get(key))
        })
        .cloned()
        .unwrap_or_else(|| key.to_string())
}
