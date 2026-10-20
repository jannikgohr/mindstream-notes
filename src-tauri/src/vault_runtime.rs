//! Startup contracts for the supervised host and explicit vault workers. The
//! established e2e mode keeps one direct process per simulated device by default.
use crate::environment::Kind;
use crate::error::{AppError, AppResult};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Role {
    Direct,
    Host,
    Worker {
        vault_id: String,
        launch_id: Uuid,
        coordinator_id: Uuid,
    },
}

impl Role {
    pub fn parse(kind: Kind, args: &[String]) -> AppResult<Self> {
        let invalid = || AppError::InvalidArg("invalid vault runtime launch arguments".into());
        if args.iter().any(|arg| arg == "--vault-worker") {
            if args.len() != 6
                || args[0] != "--vault-worker"
                || args[2] != "--launch-id"
                || args[4] != "--coordinator-id"
                || !crate::profiles::valid_id(&args[1])
            {
                return Err(invalid());
            }
            let launch_id = Uuid::parse_str(&args[3]).map_err(|_| invalid())?;
            let coordinator_id = Uuid::parse_str(&args[5]).map_err(|_| invalid())?;
            if launch_id.is_nil() || coordinator_id.is_nil() {
                return Err(invalid());
            }
            return Ok(Self::Worker {
                vault_id: args[1].clone(),
                launch_id,
                coordinator_id,
            });
        }
        if args.iter().any(|arg| {
            !matches!(
                arg.as_str(),
                crate::AUTOSTART_ARG
                    | "--onboarding"
                    | "--supervised-vaults"
                    | crate::coordinator_revival::BACKGROUND_ARG
            )
            // An invite link opened outside the app. See `deep_links`.
            && !crate::deep_links::is_app_address(arg)
        }) {
            return Err(invalid());
        }
        if args
            .iter()
            .any(|arg| arg == crate::coordinator_revival::BACKGROUND_ARG)
            && !args.iter().any(|arg| arg == "--supervised-vaults")
        {
            return Err(invalid());
        }
        if kind == Kind::Test && !args.iter().any(|arg| arg == "--supervised-vaults") {
            Ok(Self::Direct)
        } else {
            Ok(Self::Host)
        }
    }

    pub fn worker_arguments(
        vault_id: &str,
        launch_id: Uuid,
        coordinator_id: Uuid,
    ) -> AppResult<Vec<String>> {
        let args = vec![
            "--vault-worker".into(),
            vault_id.into(),
            "--launch-id".into(),
            launch_id.to_string(),
            "--coordinator-id".into(),
            coordinator_id.to_string(),
        ];
        Self::parse(Kind::Release, &args)?;
        Ok(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_dev_release_launches_are_hosts_and_existing_tests_stay_direct() {
        for kind in [Kind::Release, Kind::Dev] {
            assert_eq!(Role::parse(kind, &[]).unwrap(), Role::Host);
            assert_eq!(
                Role::parse(kind, &[crate::AUTOSTART_ARG.into()]).unwrap(),
                Role::Host
            );
        }
        assert_eq!(Role::parse(Kind::Test, &[]).unwrap(), Role::Direct);
        assert_eq!(
            Role::parse(Kind::Test, &["--supervised-vaults".into()]).unwrap(),
            Role::Host
        );
        assert_eq!(
            Role::parse(Kind::Dev, &["--onboarding".into()]).unwrap(),
            Role::Host
        );
        assert_eq!(
            Role::parse(Kind::Test, &["--onboarding".into()]).unwrap(),
            Role::Direct
        );
    }
    #[test]
    fn an_opened_link_starts_an_ordinary_launch_and_never_a_worker() {
        let address = "mindstream-notes://join?link=anything";
        for kind in [Kind::Release, Kind::Dev] {
            assert_eq!(Role::parse(kind, &[address.into()]).unwrap(), Role::Host);
        }
        assert_eq!(
            Role::parse(Kind::Test, &[address.into()]).unwrap(),
            Role::Direct
        );
        let mut worker = Role::worker_arguments("vault", Uuid::new_v4(), Uuid::new_v4()).unwrap();
        worker.push(address.into());
        assert!(Role::parse(Kind::Release, &worker).is_err());
        assert!(Role::parse(Kind::Release, &["https://example.com".into()]).is_err());
    }

    #[test]
    fn background_recovery_requires_explicit_supervision_and_cannot_be_a_worker_flag() {
        assert!(Role::parse(
            Kind::Test,
            &[crate::coordinator_revival::BACKGROUND_ARG.into()]
        )
        .is_err());
        assert_eq!(
            Role::parse(
                Kind::Test,
                &[
                    "--supervised-vaults".into(),
                    crate::coordinator_revival::BACKGROUND_ARG.into()
                ]
            )
            .unwrap(),
            Role::Host
        );
        let mut worker = Role::worker_arguments("vault", Uuid::new_v4(), Uuid::new_v4()).unwrap();
        worker.push(crate::coordinator_revival::BACKGROUND_ARG.into());
        assert!(Role::parse(Kind::Release, &worker).is_err());
    }

    #[test]
    fn explicit_target_keeps_launch_and_coordinator_identity_and_refuses_ambiguous_args() {
        let launch = Uuid::new_v4();
        let host = Uuid::new_v4();
        let args = Role::worker_arguments("vault-2", launch, host).unwrap();
        assert_eq!(
            Role::parse(Kind::Test, &args).unwrap(),
            Role::Worker {
                vault_id: "vault-2".into(),
                launch_id: launch,
                coordinator_id: host
            }
        );
        assert!(Role::worker_arguments("../other", launch, host).is_err());
        assert!(Role::worker_arguments("vault", Uuid::nil(), host).is_err());
        let mut bad = args.clone();
        bad.push("--supervised-vaults".into());
        assert!(Role::parse(Kind::Test, &bad).is_err());
        let mut bad = args.clone();
        bad[3] = "invalid launch".into();
        assert!(Role::parse(Kind::Release, &bad).is_err());
        assert!(Role::parse(Kind::Dev, &["--launch-id".into()]).is_err());
    }
}
