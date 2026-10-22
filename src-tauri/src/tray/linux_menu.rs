use gtk::{
    glib::{self, translate::from_glib_none},
    prelude::*,
};
use muda::ContextMenu;
use tauri::{image::Image, AppHandle, Manager};

use super::{handle_menu_event, TrayMenuItems, TRAY_HOTKEY_COMMANDS, TRAY_ID};

// Muda's GTK icon items use a custom box. AppIndicator cannot export its
// images or subsequent label changes. Give it GtkImageMenuItem widgets,
// whose image and label properties are understood by the desktop menu host.
pub(super) fn sync(app: &AppHandle) -> tauri::Result<()> {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return Ok(());
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let rows = menu_rows(app, &items)?;
    let app = app.clone();
    tray.with_inner_tray_icon(move |tray| {
        tray.set_menu(Some(Box::new(build_menu(&app, rows))));
    })
}

fn menu_rows(app: &AppHandle, items: &TrayMenuItems) -> tauri::Result<Vec<Row>> {
    let vault_label = items.vault_label.lock().unwrap().clone();
    let mut rows = vec![row(
        super::VAULT_ID,
        vault_label,
        false,
        include_bytes!("../../icons/tray/vault.png"),
    )];
    for (id, png) in [
        (
            super::NEW_NOTE_ID,
            include_bytes!("../../icons/tray/file-text.png").as_slice(),
        ),
        (
            super::NEW_DRAWING_ID,
            include_bytes!("../../icons/tray/pencil-ruler.png").as_slice(),
        ),
        (
            super::NEW_INK_ID,
            include_bytes!("../../icons/tray/feather.png").as_slice(),
        ),
        (
            super::NEW_DIAGRAM_ID,
            include_bytes!("../../icons/tray/workflow.png").as_slice(),
        ),
        (
            super::QUIT_ID,
            include_bytes!("../../icons/tray/log-out.png").as_slice(),
        ),
    ] {
        let Some(item) = items.by_id(id) else {
            continue;
        };
        let mut entry = row(id, item.text()?, true, png);
        entry.accelerator = TRAY_HOTKEY_COMMANDS
            .iter()
            .find(|(item_id, _)| *item_id == id)
            .and_then(|(_, command)| {
                crate::hotkeys::hotkey_accelerator(app, command.hotkey_catalogue_id())
            });
        rows.push(entry);
    }
    Ok(rows)
}

fn build_menu(app: &AppHandle, rows: Vec<Row>) -> muda::Menu {
    let menu = muda::Menu::new();
    let native = menu.gtk_context_menu();
    for entry in rows {
        if entry.id == super::NEW_NOTE_ID || entry.id == super::QUIT_ID {
            native.append(&gtk::SeparatorMenuItem::new());
        }
        let item = image_item(&entry);
        if entry.enabled {
            let app = app.clone();
            item.connect_activate(move |_| handle_menu_event(&app, entry.id));
        }
        native.append(&item);
    }
    native.show_all();
    menu
}

struct Row {
    id: &'static str,
    label: String,
    enabled: bool,
    image: Image<'static>,
    accelerator: Option<String>,
}

fn row(id: &'static str, label: String, enabled: bool, png: &'static [u8]) -> Row {
    Row {
        id,
        label,
        enabled,
        image: Image::from_bytes(png).expect("valid embedded tray icon"),
        accelerator: None,
    }
}

fn image_item(entry: &Row) -> gtk::MenuItem {
    // SAFETY: GTK is initialized, and with_inner_tray_icon runs on its main
    // thread. GtkImageMenuItem is a GtkMenuItem subclass. gtk-rs omits its
    // deprecated wrapper, but AppIndicator still requires this native type.
    let item: gtk::MenuItem = unsafe {
        from_glib_none(gtk::ffi::gtk_image_menu_item_new() as *mut gtk::ffi::GtkMenuItem)
    };
    let pixels = glib::Bytes::from_owned(entry.image.rgba().to_vec());
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_bytes(
        &pixels,
        gtk::gdk_pixbuf::Colorspace::Rgb,
        true,
        8,
        entry.image.width() as i32,
        entry.image.height() as i32,
        entry.image.width() as i32 * 4,
    );
    let pixbuf = pixbuf.scale_simple(16, 16, gtk::gdk_pixbuf::InterpType::Bilinear);
    let image = gtk::Image::from_pixbuf(pixbuf.as_ref());
    // SAFETY: item was created as GtkImageMenuItem above; GTK keeps a reference
    // to the image widget after assigning it to the menu item.
    unsafe {
        gtk::ffi::gtk_image_menu_item_set_image(item.as_ptr().cast(), image.as_ptr().cast());
        gtk::ffi::gtk_image_menu_item_set_always_show_image(item.as_ptr().cast(), 1);
    }
    item.set_label(&entry.label.replace("&&", "&"));
    item.set_sensitive(entry.enabled);
    if let Some(accelerator) = &entry.accelerator {
        let accelerator = accelerator
            .replace("CommandOrControl+", "<Primary>")
            .replace("CmdOrCtrl+", "<Primary>")
            .replace("Control+", "<Control>")
            .replace("Ctrl+", "<Control>")
            .replace("Alt+", "<Alt>")
            .replace("Shift+", "<Shift>")
            .replace("Super+", "<Super>");
        let (key, modifiers) = gtk::accelerator_parse(&accelerator);
        if let Some(label) = item
            .child()
            .and_then(|child| child.downcast::<gtk::AccelLabel>().ok())
        {
            label.set_accel(key, modifiers);
        }
    }
    item
}

#[cfg(test)]
mod tests;
