//! Second factors, the recovery key and device sessions: what each one lets
//! through, and what it does not.

mod common;

use common::keyed::{
    backup_codes, confirm, enrol, new_key, post, public, refused, signed, Authenticator, Extra,
    Person, Session, ACCOUNT_KEYS, RECOVERY_COPY,
};
use common::raw::{Frame, Socket};
use reqwest::Method;
use serde::Deserialize;
use serde_bytes::ByteBuf;
use serde_json::json;

fn url() -> &'static str {
    common::server()
}

#[tokio::test]
async fn code_is_asked_for_only_once_the_password_is_right() {
    let ann = Person::signup(url(), "ann", false).await;
    // Without a second factor the password is enough, and a code sent
    // anyway is ignored.
    ann.login(&ann.login, &Extra::none(), "Phone")
        .await
        .expect("password alone");
    ann.login(&ann.login, &Extra::code("123456"), "Phone")
        .await
        .expect("a code nobody asked for");

    let (mut authenticator, backup) = enrol(&ann).await;
    assert_eq!(backup.len(), 10);
    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["totp"], true);
    assert_eq!(status["backupCodes"], 10);
    assert_eq!(status["recoveryKey"], false);
    assert_eq!(status["sessionVerified"], true);

    // Someone guessing the password is told the password is wrong, with or
    // without a code. They do not learn that the account has a second
    // factor.
    let guess = new_key();
    for extra in [Extra::none(), Extra::code(&authenticator.wrong_code())] {
        assert_eq!(
            ann.login(&guess, &extra, "Elsewhere").await.err(),
            Some(refused(401, "login_bad_signature"))
        );
    }

    // The password alone no longer gets in.
    assert_eq!(
        ann.login(&ann.login, &Extra::none(), "Phone").await.err(),
        Some(refused(401, "totp_required"))
    );
    assert_eq!(
        ann.login(&ann.login, &Extra::code(""), "Phone").await.err(),
        Some(refused(401, "totp_required"))
    );
    let wrong = Extra::code(&authenticator.wrong_code());
    assert_eq!(
        ann.login(&ann.login, &wrong, "Phone").await.err(),
        Some(refused(401, "totp_invalid"))
    );

    let phone = ann
        .login(&ann.login, &Extra::code(&authenticator.code()), "Phone")
        .await
        .expect("password and code");
    let status = phone.get("/mindstream/security/").await.value();
    assert_eq!(status["sessionVerified"], true);
}

/// A login built by hand from a challenge, so that it can be sent twice.
fn login_answering(person: &Person, challenge: &[u8], code: Option<&str>) -> Vec<u8> {
    use ed25519_dalek::Signer;
    #[derive(serde::Serialize)]
    struct Body<'a> {
        username: &'a str,
        challenge: ByteBuf,
        host: &'a str,
        action: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        totp: Option<&'a str>,
    }
    let body = rmp_serde::to_vec_named(&Body {
        username: &person.name,
        challenge: ByteBuf::from(challenge.to_vec()),
        host: url().trim_start_matches("http://"),
        action: "login",
        totp: code,
    })
    .unwrap();
    let signature = person.login.sign(&body).to_bytes().to_vec();
    rmp_serde::to_vec_named(&json!({
        "response": ByteBuf::from(body),
        "signature": ByteBuf::from(signature),
    }))
    .unwrap()
}

async fn challenge_for(person: &Person) -> Vec<u8> {
    #[derive(Deserialize)]
    struct Challenge {
        challenge: ByteBuf,
    }
    let reply = post(
        url(),
        "/authentication/login_challenge/",
        &json!({ "username": person.name }),
    )
    .await;
    reply.decode::<Challenge>().challenge.into_vec()
}

async fn send_login(body: Vec<u8>) -> (u16, String) {
    let reply = reqwest::Client::new()
        .post(format!("{}/api/v1/authentication/login/", url()))
        .body(body)
        .send()
        .await
        .unwrap();
    let status = reply.status().as_u16();
    let body: serde_json::Value =
        rmp_serde::from_slice(&reply.bytes().await.unwrap()).unwrap_or_default();
    (status, body["code"].as_str().unwrap_or("").to_owned())
}

/// A challenge is answered once. A login sent a second time, as whoever
/// captured it on its way might, opens nothing. A request that failed
/// spends nothing, so the same challenge can be answered again.
#[tokio::test]
async fn a_challenge_is_answered_once() {
    let ann = Person::signup(url(), "once", false).await;
    let challenge = challenge_for(&ann).await;
    let login = login_answering(&ann, &challenge, None);
    assert_eq!(send_login(login.clone()).await.0, 200);
    assert_eq!(send_login(login).await, refused(400, "challenge_used"));

    let (mut authenticator, _) = enrol(&ann).await;
    let challenge = challenge_for(&ann).await;
    let wrong = login_answering(&ann, &challenge, Some(&authenticator.wrong_code()));
    assert_eq!(send_login(wrong).await, refused(401, "totp_invalid"));
    let right = login_answering(&ann, &challenge, Some(&authenticator.code()));
    assert_eq!(send_login(right).await.0, 200);
}

#[tokio::test]
async fn code_works_once() {
    let ann = Person::signup(url(), "ann", false).await;
    let (mut authenticator, backup) = enrol(&ann).await;

    // The code that confirmed the authenticator is spent already.
    let spent = Extra::code(&authenticator.last_code());
    assert_eq!(
        ann.login(&ann.login, &spent, "Phone").await.err(),
        Some(refused(401, "totp_invalid"))
    );
    let fresh = Extra::code(&authenticator.code());
    ann.login(&ann.login, &fresh, "Phone")
        .await
        .expect("a fresh code");
    // Someone who watched it being typed gains nothing.
    assert_eq!(
        ann.login(&ann.login, &fresh, "Elsewhere").await.err(),
        Some(refused(401, "totp_invalid"))
    );

    // A backup code is read however it is typed, and also works once.
    let typed = backup[0].to_lowercase().replace('-', " ");
    ann.login(&ann.login, &Extra::code(&typed), "Phone")
        .await
        .expect("a backup code");
    assert_eq!(
        ann.login(&ann.login, &Extra::code(&backup[0]), "Phone")
            .await
            .err(),
        Some(refused(401, "totp_invalid"))
    );
    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["backupCodes"], 9);
}

#[tokio::test]
async fn enrolling_signs_every_other_device_out() {
    let laptop = Person::signup(url(), "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();
    // The phone has a room open and is listening for changes.
    let device = phone.device();
    let collection = device.create_collection().await;
    let item = device.add_item(&collection).await;
    let (mut room, _) = device.enter(&collection, &item).await;
    let mut feed = device.feed().await;

    enrol(&laptop).await;

    // It signed in without a code, and a code is now what signing in takes.
    assert_eq!(room.next().await, Frame::Closed(4401));
    assert_eq!(feed.close_code().await, Some(4401));
    assert!(!phone.signed_in().await);
    assert!(laptop.signed_in().await);
}

#[tokio::test]
async fn wrong_codes_lock_the_second_factor_for_a_while() {
    let ann = Person::signup(url(), "ann", false).await;
    let (mut authenticator, backup) = enrol(&ann).await;

    let wrong = Extra::code(&authenticator.wrong_code());
    for _ in 0..5 {
        assert_eq!(
            ann.login(&ann.login, &wrong, "Phone").await.err(),
            Some(refused(401, "totp_invalid"))
        );
    }
    // Now even the right code has to wait, and so does a backup code.
    let right = Extra::code(&authenticator.code());
    assert_eq!(
        ann.login(&ann.login, &right, "Phone").await.err(),
        Some(refused(429, "totp_throttled"))
    );
    assert_eq!(
        ann.login(&ann.login, &Extra::code(&backup[0]), "Phone")
            .await
            .err(),
        Some(refused(429, "totp_throttled"))
    );
    // The device already signed in is not affected.
    assert!(ann.signed_in().await);
}

#[tokio::test]
async fn session_token_alone_cannot_set_up_an_authenticator() {
    let ann = Person::signup(url(), "ann", false).await;
    let bob = Person::signup(url(), "bob", false).await;
    let enroll = "/mindstream/totp/enroll/";

    // Whoever holds Ann's session but not her password.
    let thief = new_key();
    let reply = ann
        .signed(Method::POST, enroll, "enrollTotp", &thief, &Extra::none())
        .await;
    assert_eq!(reply.outcome(), refused(401, "login_bad_signature"));

    // A request Ann signed, replayed on Bob's session.
    let on_bob = Person {
        token: bob.token.clone(),
        ..ann
            .login(&ann.login, &Extra::none(), "Phone")
            .await
            .unwrap()
    };
    let reply = on_bob
        .signed(
            Method::POST,
            enroll,
            "enrollTotp",
            &ann.login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.outcome(), refused(403, "wrong_user"));

    // A signature made for something else.
    let reply = ann
        .signed(Method::POST, enroll, "login", &ann.login, &Extra::none())
        .await;
    assert_eq!(reply.status, 400);

    // Nothing was started, so there is nothing to confirm.
    let reply = ann
        .post("/mindstream/totp/confirm/", &json!({ "code": "123456" }))
        .await;
    assert_eq!(reply.outcome(), refused(400, "totp_not_started"));
    assert_eq!(
        ann.get("/mindstream/security/").await.value()["totp"],
        false
    );

    // Started but never confirmed: signing in still takes the password
    // alone, and a wrong code confirms nothing.
    let reply = ann
        .signed(
            Method::POST,
            enroll,
            "enrollTotp",
            &ann.login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.status, 200);
    let shown = reply.value();
    let authenticator = Authenticator::new(shown["secret"].as_str().unwrap());
    assert!(shown["url"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/Mindstream%20Tests:"));
    let reply = ann
        .post(
            "/mindstream/totp/confirm/",
            &json!({ "code": authenticator.wrong_code() }),
        )
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_invalid"));
    ann.login(&ann.login, &Extra::none(), "Phone")
        .await
        .expect("still the password alone");
}

#[tokio::test]
async fn sensitive_changes_take_the_password_and_a_code() {
    let ann = Person::signup(url(), "ann", false).await;
    let (_, backup) = enrol(&ann).await;
    let code = |index: usize| Extra::code(&backup[index]);

    // A new password.
    let new_login = new_key();
    let change = Extra::password(&new_login);
    let path = "/authentication/change_password/";
    let reply = ann
        .signed(Method::POST, path, "changePassword", &ann.login, &change)
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));
    let with_code = change.clone().with_code(&backup[0]);
    let reply = ann
        .signed(Method::POST, path, "changePassword", &ann.login, &with_code)
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));
    assert_eq!(
        ann.login(&ann.login, &code(1), "Phone").await.err(),
        Some(refused(401, "login_bad_signature"))
    );

    // A recovery key.
    let recovery = new_key();
    let set = Extra::none().with_recovery(&recovery);
    let path = "/mindstream/recovery/";
    let reply = ann
        .signed(Method::PUT, path, "setRecovery", &new_login, &set)
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));
    let with_code = set.clone().with_code(&backup[1]);
    let reply = ann
        .signed(Method::PUT, path, "setRecovery", &new_login, &with_code)
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));
    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["recoveryKey"], true);

    // Fresh backup codes. The old ones stop working.
    let path = "/mindstream/backup-codes/";
    let reply = ann
        .signed(
            Method::POST,
            path,
            "newBackupCodes",
            &new_login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));
    let reply = ann
        .signed(Method::POST, path, "newBackupCodes", &new_login, &code(2))
        .await;
    assert_eq!(reply.status, 200);
    let fresh = backup_codes(&reply);
    assert_eq!(fresh.len(), 10);
    assert!(fresh.iter().all(|code| !backup.contains(code)));

    // Turning the second factor off.
    let path = "/mindstream/totp/disable/";
    let reply = ann
        .signed(
            Method::POST,
            path,
            "disableTotp",
            &new_login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));
    let reply = ann
        .signed(Method::POST, path, "disableTotp", &new_login, &code(3))
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_invalid"));
    let reply = ann
        .signed(
            Method::POST,
            path,
            "disableTotp",
            &new_login,
            &Extra::code(&fresh[0]),
        )
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));

    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["totp"], false);
    assert_eq!(status["backupCodes"], 0);
    ann.login(&new_login, &Extra::none(), "Phone")
        .await
        .expect("the password alone again");
    // With no second factor there is none to turn off or make codes for.
    for (path, action) in [
        ("/mindstream/totp/disable/", "disableTotp"),
        ("/mindstream/backup-codes/", "newBackupCodes"),
    ] {
        let reply = ann
            .signed(Method::POST, path, action, &new_login, &Extra::none())
            .await;
        assert_eq!(reply.outcome(), refused(400, "totp_not_enabled"));
    }
}

#[tokio::test]
async fn changing_the_password_signs_every_other_device_out() {
    let laptop = Person::signup(url(), "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();
    let mut feed = phone.device().feed().await;

    let new_login = new_key();
    let reply = laptop
        .signed(
            Method::POST,
            "/authentication/change_password/",
            "changePassword",
            &laptop.login,
            &Extra::password(&new_login),
        )
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));

    assert_eq!(feed.close_code().await, Some(4401));
    assert!(!phone.signed_in().await);
    assert!(laptop.signed_in().await);
    laptop
        .login(&new_login, &Extra::none(), "Phone")
        .await
        .expect("the new password");
}

#[tokio::test]
async fn signed_in_device_replaces_a_lost_authenticator_with_the_password() {
    let ann = Person::signup(url(), "ann", false).await;
    let (mut lost, old_backup) = enrol(&ann).await;
    let enroll = "/mindstream/totp/enroll/";

    // This device confirmed the first authenticator, so it has shown a
    // second factor. That and the password start a replacement.
    let reply = ann
        .signed(
            Method::POST,
            enroll,
            "enrollTotp",
            &ann.login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.status, 200);
    let shown = reply.value();
    let mut replacement = Authenticator::new(shown["secret"].as_str().unwrap());

    // Until the replacement is confirmed the old one is what counts.
    let phone = ann
        .login(&ann.login, &Extra::code(&lost.code()), "Phone")
        .await
        .expect("the old authenticator still works");

    let new_backup = confirm(&ann, &mut replacement).await;
    assert!(!phone.signed_in().await);
    for stale in [
        lost.code_at(common::keyed::step_now() + 1),
        old_backup[0].clone(),
    ] {
        assert_eq!(
            ann.login(&ann.login, &Extra::code(&stale), "Phone")
                .await
                .err(),
            Some(refused(401, "totp_invalid"))
        );
    }
    ann.login(&ann.login, &Extra::code(&replacement.code()), "Phone")
        .await
        .expect("the new authenticator");

    // A session that never showed a second factor does not get to do the
    // same. None can exist while the factor is on, so one is made by hand.
    let pool = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE sessions SET second_factor_at = NULL
         WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
    )
    .bind(&ann.name)
    .execute(&pool)
    .await
    .unwrap();
    let reply = ann
        .signed(
            Method::POST,
            enroll,
            "enrollTotp",
            &ann.login,
            &Extra::none(),
        )
        .await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));
    let reply = ann
        .signed(
            Method::POST,
            enroll,
            "enrollTotp",
            &ann.login,
            &Extra::code(&new_backup[0]),
        )
        .await;
    assert_eq!(reply.status, 200);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryOpened {
    recovery_encrypted_content: ByteBuf,
    grant: String,
}

#[tokio::test]
async fn recovery_key_sets_a_new_password_and_takes_the_second_factor_too() {
    let ann = Person::signup(url(), "ann", true).await;
    let (_, backup) = enrol(&ann).await;
    let recovery = ann.recovery.clone().unwrap();
    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["recoveryKey"], true);
    let open = "/authentication/recover/";
    let complete = "/authentication/recover/complete/";

    // Neither a made-up key nor the password opens a recovery.
    for key in [new_key(), ann.login.clone()] {
        let reply = signed(url(), &ann.name, &key, open, "recover", &Extra::none()).await;
        assert_eq!(reply.outcome(), refused(401, "recovery_bad_signature"));
    }
    // The recovery key alone does not either: it would undo the second
    // factor for anyone who found the sheet it is written on.
    let reply = signed(url(), &ann.name, &recovery, open, "recover", &Extra::none()).await;
    assert_eq!(reply.outcome(), refused(401, "totp_required"));

    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        open,
        "recover",
        &Extra::code(&backup[0]),
    )
    .await;
    assert_eq!(reply.status, 200);
    let opened: RecoveryOpened = reply.decode();
    assert_eq!(&opened.recovery_encrypted_content[..], RECOVERY_COPY);

    // The second half needs the grant from the first and a new recovery
    // key in place of the one just typed in.
    let new_login = new_key();
    let new_recovery = new_key();
    let keys = Extra::password(&new_login).with_recovery(&new_recovery);
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        complete,
        "recoverComplete",
        &keys,
    )
    .await;
    assert_eq!(reply.outcome(), refused(401, "recovery_expired"));
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        complete,
        "recoverComplete",
        &keys.clone().with_grant("bm90IGEgZ3JhbnQ"),
    )
    .await;
    assert_eq!(reply.outcome(), refused(401, "recovery_expired"));
    let kept = Extra::password(&new_login)
        .with_recovery(&recovery)
        .with_grant(&opened.grant);
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        complete,
        "recoverComplete",
        &kept,
    )
    .await;
    assert_eq!(reply.status, 400);
    assert!(ann.signed_in().await, "a refused reset changed something");

    let granted = keys.clone().with_grant(&opened.grant);
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        complete,
        "recoverComplete",
        &granted,
    )
    .await;
    assert_eq!(reply.status, 200);
    let session: Session = reply.decode();
    assert_eq!(&session.user.encrypted_content[..], &[9u8; 64][..]);
    assert_ne!(&session.user.encrypted_content[..], ACCOUNT_KEYS);

    // Every device that was signed in is out, and the one that did the
    // reset is in, having shown the second factor on the way.
    assert!(!ann.signed_in().await);
    let recovered = Person {
        token: session.token,
        login: new_login.clone(),
        recovery: Some(new_recovery.clone()),
        url: ann.url.clone(),
        name: ann.name.clone(),
        device: "Recovered".into(),
    };
    let status = recovered.get("/mindstream/security/").await.value();
    assert_eq!(status["sessionVerified"], true);
    assert_eq!(status["totp"], true);

    // The old password and the old recovery key are both dead, and the
    // grant with them.
    assert_eq!(
        ann.login(&ann.login, &Extra::code(&backup[1]), "Phone")
            .await
            .err(),
        Some(refused(401, "login_bad_signature"))
    );
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        complete,
        "recoverComplete",
        &granted,
    )
    .await;
    assert_eq!(reply.outcome(), refused(401, "recovery_bad_signature"));
    recovered
        .login(&new_login, &Extra::code(&backup[1]), "Phone")
        .await
        .expect("the new password");
    // The new recovery key is the one that works from here on.
    let reply = signed(
        url(),
        &ann.name,
        &new_recovery,
        open,
        "recover",
        &Extra::code(&backup[2]),
    )
    .await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn account_without_a_recovery_key_cannot_be_recovered() {
    let ann = Person::signup(url(), "ann", false).await;
    // It answers the way an account with one answers a wrong key, so asking
    // does not show which accounts have a recovery key.
    for key in [new_key(), ann.login.clone()] {
        let reply = signed(
            url(),
            &ann.name,
            &key,
            "/authentication/recover/",
            "recover",
            &Extra::none(),
        )
        .await;
        assert_eq!(reply.outcome(), refused(401, "recovery_bad_signature"));
    }

    // Set afterwards, without a second factor: the password is enough.
    let recovery = new_key();
    let reply = ann
        .signed(
            Method::PUT,
            "/mindstream/recovery/",
            "setRecovery",
            &ann.login,
            &Extra::none().with_recovery(&recovery),
        )
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        "/authentication/recover/",
        "recover",
        &Extra::none(),
    )
    .await;
    assert_eq!(reply.status, 200);

    // Half a recovery key is refused.
    let half = Extra {
        recovery_pubkey: Some(public(&recovery)),
        ..Extra::none()
    };
    let reply = ann
        .signed(
            Method::PUT,
            "/mindstream/recovery/",
            "setRecovery",
            &ann.login,
            &half,
        )
        .await;
    assert_eq!(reply.status, 400);
}

#[tokio::test]
async fn devices_are_listed_and_signed_out_one_at_a_time() {
    let laptop = Person::signup(url(), "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();

    let listed = laptop.get("/mindstream/sessions/").await.value();
    let sessions = listed["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let find = |device: &str| {
        sessions
            .iter()
            .find(|session| session["deviceName"] == device)
            .unwrap_or_else(|| panic!("no session for {device}"))
    };
    assert_eq!(find("Laptop")["current"], true);
    assert_eq!(find("Phone")["current"], false);
    assert_eq!(find("Phone")["secondFactor"], false);
    assert!(find("Phone")["createdAt"].as_i64().unwrap() > 1_700_000_000);
    let phone_session = find("Phone")["id"].as_i64().unwrap();

    // The phone is in a room and holds a ticket for another visit.
    let device = phone.device();
    let collection = device.create_collection().await;
    let item = device.add_item(&collection).await;
    let (mut room, _) = device.enter(&collection, &item).await;
    let ticket = device.ticket(&collection, &item).await.unwrap();

    let reply = laptop
        .delete(&format!("/mindstream/sessions/{phone_session}/"))
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));
    assert_eq!(room.next().await, Frame::Closed(4401));
    assert!(!phone.signed_in().await);
    // The ticket was issued to a session that no longer exists.
    let mut socket = Socket::open(url(), "/api/v1/room/", None).await;
    socket.hello(&ticket).await;
    assert_eq!(socket.next().await, Frame::Closed(4403));
    // Gone is gone: a second try finds nothing.
    let reply = laptop
        .delete(&format!("/mindstream/sessions/{phone_session}/"))
        .await;
    assert_eq!(reply.status, 404);

    // Someone else's session cannot be ended, or even told apart from one
    // that does not exist.
    let bob = Person::signup(url(), "bob", false).await;
    let listed = bob.get("/mindstream/sessions/").await.value();
    let bob_session = listed["sessions"][0]["id"].as_i64().unwrap();
    let reply = laptop
        .delete(&format!("/mindstream/sessions/{bob_session}/"))
        .await;
    assert_eq!(reply.status, 404);
    assert!(bob.signed_in().await);
}

#[tokio::test]
async fn signing_out_closes_what_the_device_had_open() {
    let laptop = Person::signup(url(), "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();
    let tablet = laptop
        .login(&laptop.login, &Extra::none(), "Tablet")
        .await
        .unwrap();
    let mut laptop_feed = laptop.device().feed().await;
    let mut phone_feed = phone.device().feed().await;
    let mut tablet_feed = tablet.device().feed().await;

    // Signing out ends that device's session and nobody else's.
    let reply = phone.post("/authentication/logout/", &json!({})).await;
    assert_eq!(reply.outcome(), refused(204, ""));
    assert_eq!(phone_feed.close_code().await, Some(4401));
    assert!(!phone.signed_in().await);
    assert!(tablet.signed_in().await);

    // Signing the others out spares the device that asked.
    let reply = laptop
        .post("/mindstream/sessions/revoke-others/", &json!({}))
        .await;
    assert_eq!(reply.outcome(), refused(204, ""));
    assert_eq!(tablet_feed.close_code().await, Some(4401));
    assert!(!tablet.signed_in().await);
    assert!(laptop.signed_in().await);
    laptop_feed.expect_no_news().await;
    let listed = laptop.get("/mindstream/sessions/").await.value();
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn recovery_key_can_be_set_up_with_the_account() {
    let ann = Person::signup(url(), "ann", true).await;
    let recovery = ann.recovery.clone().unwrap();
    let reply = signed(
        url(),
        &ann.name,
        &recovery,
        "/authentication/recover/",
        "recover",
        &Extra::none(),
    )
    .await;
    assert_eq!(reply.status, 200);
    let opened: RecoveryOpened = reply.decode();
    assert_eq!(&opened.recovery_encrypted_content[..], RECOVERY_COPY);

    // Opening a recovery changes nothing by itself.
    assert!(ann.signed_in().await);
    ann.login(&ann.login, &Extra::none(), "Phone")
        .await
        .expect("the password still works");
}

/// Set how long ago the device last used its session.
/// Wait until the server has noted that the device's session was used.
async fn used_again(pool: &sqlx::PgPool, person: &Person, device: &str) {
    let noted = async {
        loop {
            let recent: bool = sqlx::query_scalar(
                "SELECT s.last_used_at > now() - interval '1 minute'
                 FROM sessions s JOIN accounts a ON a.id = s.account_id
                 WHERE a.username = $1 AND s.device_name = $2",
            )
            .bind(&person.name)
            .bind(device)
            .fetch_one(pool)
            .await
            .unwrap();
            if recent {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), noted)
        .await
        .expect("the use was noted");
}

async fn unused_for(pool: &sqlx::PgPool, person: &Person, device: &str, days: i32) {
    let changed = sqlx::query(
        "UPDATE sessions SET last_used_at = now() - make_interval(days => $3)
         WHERE device_name = $2
           AND account_id = (SELECT id FROM accounts WHERE username = $1)",
    )
    .bind(&person.name)
    .bind(device)
    .bind(days)
    .execute(pool)
    .await
    .unwrap();
    assert_eq!(changed.rows_affected(), 1, "one session for {device}");
}

#[tokio::test]
async fn session_nobody_used_for_too_long_ends_when_its_device_comes_back() {
    let url = common::start_server(|config| config.session_idle_days = 30);
    let pool = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    let laptop = Person::signup(&url, "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();
    let mut phone_feed = phone.device().feed().await;

    // Within the limit the device is let in, and that counts as use.
    unused_for(&pool, &laptop, "Phone", 29).await;
    assert!(phone.signed_in().await);
    // The use is written down after the answer. Until it is, it could land
    // on top of the next step and give the session back its time.
    used_again(&pool, &laptop, "Phone").await;

    // Past it, the request that comes back is refused like any request with
    // a token the server does not know, and what the session had open goes.
    unused_for(&pool, &laptop, "Phone", 31).await;
    assert!(!phone.signed_in().await);
    assert_eq!(phone_feed.close_code().await, Some(4401));
    // It is gone, not waiting to be used again.
    assert!(!phone.signed_in().await);

    // Nobody else's session went with it.
    assert!(laptop.signed_in().await);
    let listed = laptop.get("/mindstream/sessions/").await.value();
    let devices: Vec<&str> = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["deviceName"].as_str().unwrap())
        .collect();
    assert_eq!(devices, vec!["Laptop"]);
}

#[tokio::test]
async fn sweep_ends_idle_sessions_and_a_limit_of_zero_ends_none() {
    let pool = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    let laptop = Person::signup(url(), "ann", false).await;
    let phone = laptop
        .login(&laptop.login, &Extra::none(), "Phone")
        .await
        .unwrap();
    let tablet = laptop
        .login(&laptop.login, &Extra::none(), "Tablet")
        .await
        .unwrap();
    let mut phone_feed = phone.device().feed().await;
    let mut tablet_feed = tablet.device().feed().await;

    // The server looks every few minutes. This is that look, asked for
    // now, with the limit a server has when nothing sets one: 90 days.
    unused_for(&pool, &laptop, "Phone", 91).await;
    unused_for(&pool, &laptop, "Tablet", 89).await;
    let state = common::admin_state().await;
    let ended = mindstream_server::admin::end_idle_sessions(&state)
        .await
        .unwrap();
    assert!(ended >= 1, "ended {ended}");

    // The phone never came back, and its session is gone all the same.
    let left: Vec<String> = sqlx::query_scalar(
        "SELECT device_name FROM sessions
         WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         ORDER BY device_name",
    )
    .bind(&laptop.name)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(left, vec!["Laptop", "Tablet"]);
    assert_eq!(phone_feed.close_code().await, Some(4401));
    assert!(!phone.signed_in().await);
    tablet_feed.expect_no_news().await;
    assert!(tablet.signed_in().await);

    // A server told never to end a session for being idle does not, however
    // long ago that was.
    let lenient = common::start_server(|config| config.session_idle_days = 0);
    let bob = Person::signup(&lenient, "bob", false).await;
    unused_for(&pool, &bob, "Laptop", 5000).await;
    assert!(bob.signed_in().await);
    assert!(bob.signed_in().await);
}
