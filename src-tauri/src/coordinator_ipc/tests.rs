use super::*;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Barrier};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ms-coordinator-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn owner(&self) -> Coordinator {
        match elect(&self.0).unwrap() {
            Election::Owner(owner) => owner,
            Election::Existing => panic!("unexpected existing owner"),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn operation(payload: Value) -> Request {
    Request {
        id: Uuid::new_v4(),
        payload,
    }
}

#[test]
fn activation_metadata_excludes_broadcast_grants_and_never_controls_ownership() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let endpoint = owner.endpoint().clone();
    assert_eq!(endpoint.activation_process_id(), Some(std::process::id()));
    for id in [0, u32::MAX] {
        let mut unsafe_target = endpoint.clone();
        unsafe_target.process_id = Some(id);
        assert!(validate_endpoint(&unsafe_target).is_err());
        assert!(unsafe_target.activation_process_id().is_none());
    }
    let mut legacy = serde_json::to_value(&endpoint).unwrap();
    legacy.as_object_mut().unwrap().remove("process_id");
    let legacy: Endpoint = serde_json::from_value(legacy).unwrap();
    validate_endpoint(&legacy).unwrap();
    assert!(legacy.activation_process_id().is_none());
    fs::write(
        fixture.0.join(ENDPOINT),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Existing));
    drop(owner);
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Owner(_)));
}

#[test]
fn endpoint_retries_preserve_the_operation_and_explicit_rejection_is_not_retried() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let endpoint = owner.endpoint().clone();
    let request = operation(serde_json::json!({"probe":true}));
    let expected_id = request.id;
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let server = owner
        .serve(move |request| {
            assert_eq!(request.id, expected_id);
            if seen.fetch_add(1, Ordering::AcqRel) == 0 {
                // Let the first reply miss its deadline. The retry must remain the
                // same operation, since that first handler may already have acted.
                thread::sleep(SOCKET_TIMEOUT + Duration::from_millis(100));
            }
            Ok(serde_json::json!({"accepted":true}))
        })
        .unwrap();
    assert_eq!(
        endpoint.retry_call(&request).unwrap().unwrap()["accepted"],
        true
    );
    assert_eq!(calls.load(Ordering::Acquire), 2);
    server.stop();

    let owner = fixture.owner();
    let endpoint = owner.endpoint().clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let server = owner
        .serve(move |_| {
            seen.fetch_add(1, Ordering::AcqRel);
            Err("explicitly rejected".into())
        })
        .unwrap();
    assert!(endpoint.retry_call(&request).unwrap().is_err());
    assert_eq!(calls.load(Ordering::Acquire), 1);
    server.stop();
}

#[test]
fn ownership_ignores_stale_files_and_replaces_endpoint_only_after_release() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join(".coordinator.lock"),
        b"old lock bytes and nonexistent pid",
    )
    .unwrap();
    fs::write(fixture.0.join(ENDPOINT), b"stale endpoint").unwrap();
    let first = fixture.owner();
    let before = fs::read(fixture.0.join(ENDPOINT)).unwrap();
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Existing));
    assert_eq!(fs::read(fixture.0.join(ENDPOINT)).unwrap(), before);
    let instance = first.endpoint.instance;
    drop(first);
    let second = fixture.owner();
    assert_ne!(second.endpoint.instance, instance);
    assert_ne!(fs::read(fixture.0.join(ENDPOINT)).unwrap(), before);
}

#[test]
fn racing_launches_elect_exactly_one_owner() {
    let fixture = Fixture::new();
    let barrier = Barrier::new(8);
    let results = thread::scope(|scope| {
        let threads: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    elect(&fixture.0).unwrap()
                })
            })
            .collect();
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Election::Owner(_)))
            .count(),
        1
    );
}

#[test]
fn authenticated_requests_correlate_replies_and_keep_independent_roots_separate() {
    let a = Fixture::new();
    let b = Fixture::new();
    let owner_a = a.owner();
    let owner_b = b.owner();
    let endpoint_a = owner_a.endpoint().clone();
    let endpoint_b = owner_b.endpoint().clone();
    let server_a = owner_a
        .serve(|request| Ok(serde_json::json!({"root": "a", "payload": request.payload})))
        .unwrap();
    let server_b = owner_b.serve(|_| Ok(Value::String("b".into()))).unwrap();
    let input = operation(serde_json::json!({"activate": true}));
    assert_eq!(request(&a.0, &input).unwrap().unwrap()["root"], "a");
    assert_eq!(endpoint_b.call(&input).unwrap().unwrap(), "b");
    let mut mixed = endpoint_a.clone();
    mixed.address = endpoint_b.address;
    assert!(mixed.call(&input).is_err());
    server_a.stop();
    server_b.stop();
}

#[test]
fn bad_auth_version_and_frame_size_never_reach_dispatcher() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let endpoint = owner.endpoint().clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let server = owner
        .serve(move |_| {
            count.fetch_add(1, Ordering::AcqRel);
            Ok(Value::Null)
        })
        .unwrap();
    let input = operation(Value::Null);
    let mut wrong = endpoint.clone();
    wrong.secret = STANDARD.encode([7u8; 32]);
    assert!(wrong.call(&input).is_err());
    let mut stream = TcpStream::connect(endpoint.address).unwrap();
    socket_options(&stream).unwrap();
    write_frame(
        &mut stream,
        &Wire {
            version: 2,
            secret: endpoint.secret.clone(),
            request: input.clone(),
        },
        Instant::now() + SOCKET_TIMEOUT,
    )
    .unwrap();
    assert!(read_frame::<Reply>(&mut stream, Instant::now() + SOCKET_TIMEOUT).is_err());
    let mut stream = TcpStream::connect(endpoint.address).unwrap();
    stream
        .write_all(&((MAX_FRAME + 1) as u32).to_be_bytes())
        .unwrap();
    assert!(read_frame::<Reply>(&mut stream, Instant::now() + SOCKET_TIMEOUT).is_err());
    assert_eq!(calls.load(Ordering::Acquire), 0);
    assert!(endpoint
        .call(&operation(Value::String("x".repeat(MAX_FRAME))))
        .is_err());
    assert_eq!(endpoint.call(&input).unwrap().unwrap(), Value::Null);
    server.stop();
}

#[test]
fn partial_frames_obey_one_absolute_deadline() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut receiver, _) = listener.accept().unwrap();
    peer.write_all(&[0]).unwrap();
    assert!(
        read_frame::<Wire>(&mut receiver, Instant::now() + Duration::from_millis(100)).is_err()
    );
}

#[test]
fn worker_listener_does_not_replace_root_endpoint_or_take_its_lease() {
    let fixture = Fixture::new();
    let root_owner = fixture.owner();
    let original = fs::read(fixture.0.join(ENDPOINT)).unwrap();
    let vault = crate::storage_locks::VaultLock::acquire(&fixture.0.join("vault")).unwrap();
    let worker = Coordinator::for_worker(&vault).unwrap();
    let endpoint = worker.endpoint().clone();
    let server = worker
        .serve(|_| Ok(Value::String("worker".into())))
        .unwrap();
    assert_eq!(
        endpoint.call(&operation(Value::Null)).unwrap().unwrap(),
        "worker"
    );
    assert_eq!(fs::read(fixture.0.join(ENDPOINT)).unwrap(), original);
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Existing));
    server.stop();
    drop(vault);
    drop(root_owner);
}

#[test]
fn shutdown_keeps_ownership_until_accepted_handler_finishes() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let endpoint = owner.endpoint().clone();
    let (entered, received) = mpsc::channel();
    let gate = Arc::new(Barrier::new(2));
    let handler_gate = gate.clone();
    let server = owner
        .serve(move |_| {
            entered.send(()).unwrap();
            handler_gate.wait();
            Ok(Value::Null)
        })
        .unwrap();
    let caller = thread::spawn(move || endpoint.call(&operation(Value::Null)));
    received.recv_timeout(SOCKET_TIMEOUT).unwrap();
    let stopping = thread::spawn(move || server.stop());
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Existing));
    gate.wait();
    assert_eq!(caller.join().unwrap().unwrap().unwrap(), Value::Null);
    stopping.join().unwrap();
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Owner(_)));
}

#[test]
fn stale_endpoint_cannot_redirect_client_to_non_loopback_host() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let mut endpoint = owner.endpoint().clone();
    endpoint.address = "192.0.2.1:1234".parse().unwrap();
    fs::write(
        fixture.0.join(ENDPOINT),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    assert!(Endpoint::read(&fixture.0).is_err());
    assert!(endpoint.call(&operation(Value::Null)).is_err());
    endpoint.address = "127.0.0.1:0".parse().unwrap();
    assert!(endpoint.call(&operation(Value::Null)).is_err());
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn terminated_process_releases_ownership_without_removing_records() {
    let fixture = Fixture::new();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "coordinator_ipc::tests::child_holds_coordinator",
        ])
        .env("MS_COORDINATOR_TEST_ROOT", &fixture.0)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = ChildGuard(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.0.join("child-ready").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "coordinator child exited before ownership"
        );
        assert!(
            Instant::now() < deadline,
            "coordinator child startup timed out"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let before = Endpoint::read(&fixture.0).unwrap();
    assert!(matches!(elect(&fixture.0).unwrap(), Election::Existing));
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(fixture.0.join(".coordinator.lock").exists());
    assert!(fixture.0.join(ENDPOINT).exists());
    let next = fixture.owner();
    assert_ne!(next.endpoint.instance, before.instance);
    assert_ne!(next.endpoint.secret, before.secret);
}

#[test]
#[ignore = "subprocess fixture; only run with its disposable root"]
fn child_holds_coordinator() {
    let Some(root) = std::env::var_os("MS_COORDINATOR_TEST_ROOT") else {
        return;
    };
    let fixture = Fixture(std::path::PathBuf::from(root));
    let owner = fixture.owner();
    let _server = owner.serve(|_| Ok(Value::Null)).unwrap();
    fs::write(fixture.0.join("child-ready"), b"ready").unwrap();
    loop {
        thread::park();
    }
}

#[cfg(unix)]
#[test]
fn endpoint_secret_is_published_with_owner_only_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let _owner = fixture.owner();
    assert_eq!(
        fs::metadata(fixture.0.join(ENDPOINT))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
