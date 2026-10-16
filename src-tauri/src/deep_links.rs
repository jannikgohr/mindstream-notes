//! Invite links opened outside the app.
//!
//! An invite link is a web address, so a browser opens it. The page it lands
//! on offers the same link under the app's own scheme,
//! `mindstream-notes://join?link=…`, and the operating system hands an
//! address under that scheme to the app: as its one argument when that
//! starts the app, and through the instance already running when there is
//! one (see `builder`).
//!
//! Under the supervised runtime the process that receives a link is the
//! coordinator, which has no window. It passes the link to the vault used
//! last, whose window shows it (see `vault_supervisor`). A second launch is
//! handed to the coordinator by the runtime's own election, not by the
//! single-instance plugin, which would end every vault process it starts.
//!
//! Receiving a link does nothing but show it. The app comes to the front and
//! opens the dialog for joining a shared folder with the link filled in.
//! Nothing is asked of any server until the user goes on from there. That
//! matters, because anything on the device can open an address under the
//! scheme, with any link inside.
//!
//! The scheme is registered by the installer, from `tauri.conf.json`. This
//! module never registers it itself: a build run from a checkout must not
//! take the scheme away from the installed app.

use std::sync::Mutex;

use reqwest::Url;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::app_events::AppEvent;

/// The scheme the operating system knows the app by. Written down for
/// every side in `protocol/links`.
pub const SCHEME: &str = "mindstream-notes";
/// What follows the scheme in an address that carries an invite link.
const JOIN: &str = "join";
const LINK_PARAMETER: &str = "link";
/// Far more than a link needs. Bounds what one process passes another.
const MAX_LINK_LENGTH: usize = 4096;

/// Whether a launch argument is an address under the app's scheme, which the
/// operating system passes when a link is opened. It may still carry no
/// invite link; then nothing comes of it.
pub(crate) fn is_app_address(argument: &str) -> bool {
    Url::parse(argument.trim()).is_ok_and(|url| url.scheme() == SCHEME)
}

/// The first invite link among addresses the operating system handed over.
/// The rest are not this app's to act on.
pub(crate) fn invite_link_among(addresses: impl IntoIterator<Item = String>) -> Option<String> {
    addresses
        .into_iter()
        .find_map(|address| invite_link_in(&address))
}

/// Whether text that came from another process is an invite link.
pub(crate) fn is_invite_link(link: &str) -> bool {
    link.len() <= MAX_LINK_LENGTH && etebase::InviteLink::parse(link).is_ok()
}

/// The invite link an address under the app's scheme carries. `None` for
/// any other address, and for one whose link is not an invite link, so
/// that nothing but an invite link ever reaches the dialog.
pub(crate) fn invite_link_in(address: &str) -> Option<String> {
    let url = Url::parse(address.trim()).ok()?;
    if url.scheme() != SCHEME || url.host_str() != Some(JOIN) {
        return None;
    }
    if !matches!(url.path(), "" | "/") {
        return None;
    }
    let mut link = url
        .query_pairs()
        .find(|(name, _)| name == LINK_PARAMETER)?
        .1
        .into_owned();
    // The page that builds these addresses encodes the link, `#` and all.
    // One written by hand may not, and its secret then reads as the
    // fragment of the address around it.
    if !link.contains('#') {
        if let Some(secret) = url.fragment() {
            link = format!("{link}#{secret}");
        }
    }
    etebase::InviteLink::parse(&link).ok()?;
    Some(link)
}

/// The invite link the operating system handed over last, until the window
/// has taken it. A link that starts the app arrives before there is a
/// window to show it in.
#[derive(Default)]
pub struct PendingInviteLink(Mutex<Option<String>>);

impl PendingInviteLink {
    fn put(&self, link: String) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(link);
    }

    fn take(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

/// Keep an invite link for the window and tell it to come and get it.
pub(crate) fn hand_over<R: Runtime>(app: &AppHandle<R>, link: String) {
    // Never the link itself in a log: its secret is the right to join.
    log::info!("[deep-link] an invite link was opened from outside the app");
    if let Some(pending) = app.try_state::<PendingInviteLink>() {
        pending.put(link);
    }
    let event = AppEvent::InviteLinkOpened.as_str();
    if let Err(err) = app.emit(event, ()) {
        log::warn!("[deep-link] failed to emit {event}: {err}");
    }
}

/// The invite link that was opened from outside the app, once. The window
/// asks when it starts and again whenever it is told that one arrived.
#[tauri::command]
pub fn take_pending_invite_link(pending: State<'_, PendingInviteLink>) -> Option<String> {
    pending.take()
}

/// Test-only: hand the app an address the way the operating system does.
/// The suite cannot click a link in a browser, and must not register the
/// scheme on the machine it runs on.
#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub fn e2e_open_address(app: AppHandle, address: String) -> bool {
    let Some(link) = invite_link_in(&address) else {
        return false;
    };
    hand_over(&app, link);
    true
}

/// Asks a build that runs on a data directory of its own to take part in
/// the single-instance hand-over all the same. For trying the second-launch
/// path from a checkout. It means nothing to an installed build, which has
/// no such data directory to begin with.
#[cfg(desktop)]
const SINGLE_INSTANCE_ENV: &str = "MINDSTREAM_SINGLE_INSTANCE";

/// Whether this process hands a second launch over to the first through
/// the single-instance plugin.
///
/// Never under the supervised runtime: its coordinator and its vault
/// processes are instances of the same app, and the coordinator's election
/// already hands a second launch over. That leaves a direct process, which
/// only a test environment runs. A build pointed at a data directory of its
/// own is an extra instance on purpose: a second device in a test, or a
/// developer's second window on another vault. It stays out of it unless it
/// is asked in.
fn hands_over_to_first_instance(
    supervised: bool,
    own_data_directory: bool,
    asked_in: bool,
) -> bool {
    !supervised && (!own_data_directory || asked_in)
}

/// Whether this launch runs under the supervised runtime. A launch whose
/// arguments make no sense counts as one; its setup refuses them.
#[cfg(desktop)]
fn supervised(kind: crate::environment::Kind) -> bool {
    crate::vault_supervisor::startup_role(kind)
        .map_or(true, |role| role != crate::vault_runtime::Role::Direct)
}

/// The app builder with what has to come before every other plugin.
///
/// A link clicked while the app is running makes the operating system
/// start the app a second time, with the link as its argument. The
/// single-instance plugin catches that: the second process passes its
/// arguments to the first and ends, and the first comes to the front. It
/// has to be registered first, so that a second process ends before it
/// has opened the database or the session.
#[cfg(desktop)]
pub fn builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default();
    let kind = crate::environment::kind();
    let builder = if hands_over_to_first_instance(
        supervised(kind),
        kind == crate::environment::Kind::Test,
        std::env::var_os(SINGLE_INSTANCE_ENV).is_some(),
    ) {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The plugin has passed the arguments on already, see `listen`.
            // Link or no link, someone asked for the app.
            crate::tray::focus_main_window(app);
        }))
    } else {
        builder
    };
    builder.plugin(tauri_plugin_deep_link::init())
}

/// Start listening for addresses, and take the one the app was started
/// with, if it was. Called once the app's state is in place.
#[cfg(desktop)]
pub fn listen(app: &AppHandle) {
    watch(
        app,
        |app, link| {
            hand_over(app, link);
            crate::tray::focus_main_window(app);
        },
        // Started by a link. The plugin read the argument before anything
        // was listening, and the window is not there yet, so the link waits.
        hand_over,
    );
}

/// The same for the coordinator, which has no window to show a link in.
/// Every link it receives goes on to a vault.
#[cfg(desktop)]
pub fn listen_for_vaults(app: &AppHandle) {
    let mut started = None;
    watch(app, crate::vault_supervisor::run_invite_link, |_, link| {
        started = Some(link)
    });
    // The plugin takes a link from the arguments only when it is the one
    // argument. Read them as a second launch does, so that a launch with
    // `--supervised-vaults` before the link starts the same way.
    if let Some(link) = started.or_else(|| invite_link_among(std::env::args().skip(1))) {
        crate::vault_supervisor::run_invite_link(app, link);
    }
}

/// Pass each invite link the operating system hands this process to
/// `opened`, and the one it started with, if any, to `started`.
#[cfg(desktop)]
fn watch(
    app: &AppHandle,
    opened: impl Fn(&AppHandle, String) + Send + Sync + 'static,
    started: impl FnOnce(&AppHandle, String),
) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        if let Some(link) = invite_link_among(event.urls().into_iter().map(|url| url.to_string())) {
            opened(&handle, link);
        }
    });

    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            if let Some(link) = invite_link_among(urls.into_iter().map(|url| url.to_string())) {
                started(app, link);
            }
        }
        Ok(None) => {}
        Err(err) => {
            log::warn!("[deep-link] could not read the address the app started with: {err}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The addresses every side agrees on, see `protocol/links`.
    fn written_down() -> serde_json::Value {
        serde_json::from_str(include_str!("../../protocol/links/invite-links.json"))
            .expect("the invite link file is JSON")
    }

    #[test]
    fn scheme_is_the_one_written_down() {
        assert_eq!(written_down()["appScheme"], SCHEME);
    }

    #[test]
    fn address_under_the_apps_scheme_gives_up_its_invite_link() {
        for example in written_down()["appAddresses"]["valid"].as_array().unwrap() {
            let address = example["address"].as_str().unwrap();
            assert_eq!(
                invite_link_in(address).as_deref(),
                example["link"].as_str(),
                "{address}"
            );
        }
    }

    /// Whatever else arrives as an argument is not a link to act on: another
    /// app's address, another action, a link that is not an invite link, a
    /// flag, a file.
    #[test]
    fn nothing_else_is_taken_for_an_invite_link() {
        for address in written_down()["appAddresses"]["invalid"]
            .as_array()
            .unwrap()
        {
            let address = address.as_str().unwrap();
            assert_eq!(invite_link_in(address), None, "{address}");
        }
    }

    /// The app reads a link with the client library, and the window reads it
    /// with its own few lines to react while someone types. The file holds
    /// what both have to agree on. This is the library's half.
    #[test]
    fn client_library_reads_the_links_written_down() {
        let written = written_down();
        for example in written["links"]["valid"].as_array().unwrap() {
            let text = example["link"].as_str().unwrap();
            let link = etebase::InviteLink::parse(text)
                .unwrap_or_else(|err| panic!("{text:?} should be a link: {err}"));
            assert_eq!(link.server_url().as_str(), example["server"], "{text:?}");
            assert_eq!(link.uid(), example["uid"], "{text:?}");
        }
        for text in written["links"]["invalid"].as_array().unwrap() {
            let text = text.as_str().unwrap();
            assert!(etebase::InviteLink::parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn extra_instance_on_its_own_data_stays_out_unless_asked_in() {
        // A direct process on shared data: a second launch is handed over.
        assert!(hands_over_to_first_instance(false, false, false));
        assert!(hands_over_to_first_instance(false, false, true));
        // A test device or a second vault runs beside the others.
        assert!(!hands_over_to_first_instance(false, true, false));
        assert!(hands_over_to_first_instance(false, true, true));
    }

    #[test]
    fn supervised_processes_never_use_the_single_instance_plugin() {
        // The coordinator's election hands a second launch over, and every
        // vault process is an instance of the same app.
        for own_data_directory in [false, true] {
            for asked_in in [false, true] {
                assert!(!hands_over_to_first_instance(
                    true,
                    own_data_directory,
                    asked_in
                ));
            }
        }
    }

    #[test]
    fn the_first_invite_link_among_launch_arguments_is_the_one_taken() {
        let valid = written_down()["appAddresses"]["valid"].clone();
        let first = valid[0]["address"].as_str().unwrap();
        let addresses = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            invite_link_among(addresses(&[
                "--supervised-vaults",
                "mindstream-notes://join?link=nonsense",
                first,
            ])),
            invite_link_in(first)
        );
        assert_eq!(
            invite_link_among(addresses(&["--supervised-vaults", "/home/user/notes.md"])),
            None
        );
    }

    #[test]
    fn launch_arguments_under_the_scheme_are_addresses_whatever_they_carry() {
        for example in written_down()["appAddresses"]["valid"].as_array().unwrap() {
            assert!(is_app_address(example["address"].as_str().unwrap()));
        }
        assert!(is_app_address("mindstream-notes://join?link=nonsense"));
        assert!(!is_app_address("--supervised-vaults"));
        assert!(!is_app_address("https://example.com/join"));
        assert!(!is_app_address("/home/user/notes.md"));
    }

    #[test]
    fn only_an_invite_link_passes_between_processes() {
        let written = written_down();
        for example in written["links"]["valid"].as_array().unwrap() {
            assert!(is_invite_link(example["link"].as_str().unwrap()));
        }
        for text in written["links"]["invalid"].as_array().unwrap() {
            assert!(!is_invite_link(text.as_str().unwrap()));
        }
        let valid = written["links"]["valid"][0]["link"].as_str().unwrap();
        assert!(!is_invite_link(&format!(
            "{valid}{}",
            "a".repeat(MAX_LINK_LENGTH)
        )));
    }

    #[test]
    fn link_waits_until_it_is_taken_and_is_taken_once() {
        let pending = PendingInviteLink::default();
        assert_eq!(pending.take(), None);

        pending.put("first".into());
        pending.put("second".into());
        // Only the last one: a second click replaces the first.
        assert_eq!(pending.take().as_deref(), Some("second"));
        assert_eq!(pending.take(), None);
    }
}
