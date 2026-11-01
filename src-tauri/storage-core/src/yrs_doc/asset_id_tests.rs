use std::collections::HashMap;

use yrs::types::Attrs;
use yrs::{
    Any, GetString, Map, Out, Text, Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

use super::{encode_state, load, replace_asset_id};

#[test]
fn replaces_link_href_and_text_without_flattening_rich_text() {
    const OLD_ID: &str = "asset-old";
    const NEW_ID: &str = "asset-replacement";

    let doc = yrs::Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let preserved_embed = Any::Map(
        HashMap::from([
            ("kind".to_string(), Any::from("emoji")),
            ("value".to_string(), Any::from("🌟")),
        ])
        .into(),
    );
    {
        let mut txn = doc.transact_mut();
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
        let link = Any::Map(
            HashMap::from([
                (
                    "href".to_string(),
                    Any::from(format!("attachment:{OLD_ID}")),
                ),
                ("title".to_string(), Any::from("linked asset")),
            ])
            .into(),
        );
        let marks = Attrs::from([
            ("link".into(), link),
            ("strong".into(), Any::Map(HashMap::new().into())),
        ]);
        text.insert_with_attributes(
            &mut txn,
            0,
            &format!("Before 🌍 attachment:{OLD_ID} after"),
            marks,
        );
        let end = text.len(&txn);
        text.insert_embed(&mut txn, end, preserved_embed.clone());
    }

    let replaced = replace_asset_id(&encode_state(&doc), OLD_ID, NEW_ID);
    let replaced_doc = load(&replaced);
    let replaced_fragment = replaced_doc.get_or_insert_xml_fragment("prosemirror");
    let txn = replaced_doc.transact();
    let text = replaced_fragment
        .successors(&txn)
        .find_map(|node| match node {
            yrs::XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .expect("rich-text node should survive replacement");

    let mut raw_text = String::new();
    let mut embed = None;
    for segment in text.diff(&txn, |_| ()) {
        match segment.insert {
            Out::Any(Any::String(value)) => {
                raw_text.push_str(&value);
                let attrs = segment.attributes.expect("text marks should remain");
                assert_eq!(attrs.get("strong"), Some(&Any::Map(HashMap::new().into())));
                let Some(Any::Map(link)) = attrs.get("link") else {
                    panic!("link mark should remain a structured map");
                };
                assert_eq!(
                    link.get("href"),
                    Some(&Any::from(format!("attachment:{NEW_ID}")))
                );
                assert_eq!(link.get("title"), Some(&Any::from("linked asset")));
            }
            Out::Any(value) => embed = Some(value),
            _ => {}
        }
    }

    assert_eq!(raw_text, format!("Before 🌍 attachment:{NEW_ID} after"));
    assert_eq!(embed, Some(preserved_embed));
    assert!(!text.get_string(&txn).contains("&lt;link"));
}

#[test]
fn replaces_excalidraw_metadata_and_xml_element_attributes() {
    const OLD_ID: &str = "asset-old";
    const NEW_ID: &str = "asset-new";

    let doc = yrs::Doc::new();
    let files = doc.get_or_insert_map("excalidraw:files");
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        files.insert(
            &mut txn,
            "file",
            Any::Map(
                HashMap::from([
                    ("assetId".to_string(), Any::from(OLD_ID)),
                    ("mimeType".to_string(), Any::from("image/png")),
                ])
                .into(),
            ),
        );
        let image = fragment.push_back(&mut txn, XmlElementPrelim::empty("image"));
        image.insert_attribute(&mut txn, "src", format!("attachment:{OLD_ID}"));
    }

    let replaced = replace_asset_id(&encode_state(&doc), OLD_ID, NEW_ID);
    let replaced_doc = load(&replaced);
    let files = replaced_doc.get_or_insert_map("excalidraw:files");
    let fragment = replaced_doc.get_or_insert_xml_fragment("prosemirror");
    let txn = replaced_doc.transact();

    let Some(Out::Any(Any::Map(file))) = files.get(&txn, "file") else {
        panic!("Excalidraw file metadata should remain a plain map");
    };
    assert_eq!(file.get("assetId"), Some(&Any::from(NEW_ID)));
    assert_eq!(file.get("mimeType"), Some(&Any::from("image/png")));

    let image = fragment
        .successors(&txn)
        .find_map(|node| match node {
            yrs::XmlOut::Element(element) => Some(element),
            _ => None,
        })
        .expect("image element should survive replacement");
    assert_eq!(
        image.get_attribute(&txn, "src"),
        Some(Out::Any(Any::from("attachment:asset-new")))
    );
}

#[test]
fn absent_asset_id_returns_the_original_bytes() {
    let state = super::init_with_markdown("No asset reference here");
    assert_eq!(replace_asset_id(&state, "missing", "new"), state);
}
