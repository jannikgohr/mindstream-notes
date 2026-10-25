//! Why a host call refused or failed.

/// The error every host operation returns.
///
/// The variants line up with the WIT `error` variant a component sees, plus
/// two that are not errors to the guest at all: [`HostError::Budget`] and
/// [`HostError::Cancelled`] stop the guest instead of returning to it, so a
/// plugin cannot catch its own deadline and carry on.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// The call needs a permission the user did not grant.
    #[error("plugin lacks permission {0}")]
    Denied(&'static str),
    /// A malformed or unsafe argument.
    #[error("{0}")]
    Invalid(String),
    /// Something that does not exist here: a missing tool, no data directory.
    #[error("{0}")]
    Unavailable(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The call ran out of time.
    #[error("script exceeded its time budget")]
    Budget,
    /// The host stopped the call: the plugin was disabled or removed, or the
    /// app is shutting down.
    #[error("plugin call was cancelled")]
    Cancelled,
}

impl HostError {
    /// True for the two variants that end the call rather than return to it.
    pub fn is_fatal(&self) -> bool {
        matches!(self, HostError::Budget | HostError::Cancelled)
    }
}

pub type HostResult<T> = Result<T, HostError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_budget_and_cancellation_end_the_call() {
        assert!(HostError::Budget.is_fatal());
        assert!(HostError::Cancelled.is_fatal());
        assert!(!HostError::Denied("notes.read").is_fatal());
        assert!(!HostError::Invalid("x".into()).is_fatal());
        assert!(!HostError::Unavailable("x".into()).is_fatal());
        assert!(!HostError::Io(std::io::Error::other("x")).is_fatal());
    }

    #[test]
    fn messages_name_what_went_wrong() {
        assert_eq!(
            HostError::Denied("notes.read").to_string(),
            "plugin lacks permission notes.read"
        );
        assert_eq!(
            HostError::Budget.to_string(),
            "script exceeded its time budget"
        );
        assert_eq!(HostError::Invalid("bad".into()).to_string(), "bad");
    }
}
