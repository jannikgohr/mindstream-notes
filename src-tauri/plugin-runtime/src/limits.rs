//! Resource bounds for one plugin call.
//!
//! A manifest may ask for memory and time with `limits.memoryBytes` and
//! `limits.timeoutMs`. Only the host decides: [`LimitPolicy::resolve`] clamps
//! both into a range that belongs to the runtime.

use std::cell::Cell;
use std::time::{Duration, Instant};

use crate::error::{HostError, HostResult};
use crate::process;

/// What one call is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Guest memory cap in bytes. For Wasm this is the linear memory the
    /// component may grow to, not the host process's memory.
    pub memory_bytes: usize,
    /// The guest's own computing time.
    pub timeout: Duration,
}

/// The defaults and ranges one runtime applies to manifest limits.
#[derive(Debug, Clone, Copy)]
pub struct LimitPolicy {
    pub default_memory: usize,
    pub min_memory: usize,
    pub max_memory: usize,
    pub default_timeout: Duration,
    pub min_timeout: Duration,
    pub max_timeout: Duration,
}

const MIB: usize = 1024 * 1024;

/// Luau keeps the bounds it has always had: 1 to 64 MiB, default 16 MiB,
/// 50 ms to 5 s, default 500 ms.
pub const LUAU: LimitPolicy = LimitPolicy {
    default_memory: 16 * MIB,
    min_memory: MIB,
    max_memory: 64 * MIB,
    default_timeout: Duration::from_millis(500),
    min_timeout: Duration::from_millis(50),
    max_timeout: Duration::from_secs(5),
};

/// Wasm components carry their language runtime in their own linear memory,
/// so the floor is higher. A QuickJS component starts in under 2 MiB, and the
/// 32 MiB default leaves room for a few MiB of strings both ways. The memory
/// ceiling covers a plugin that moves a large base64 document through itself.
/// The time ceiling stays Luau's: an interpreter in a sandbox is slower, which
/// the 1 s default absorbs, but a port should not quietly get longer runs.
pub const WASM: LimitPolicy = LimitPolicy {
    default_memory: 32 * MIB,
    min_memory: 4 * MIB,
    max_memory: 256 * MIB,
    default_timeout: Duration::from_millis(1000),
    min_timeout: Duration::from_millis(50),
    max_timeout: Duration::from_secs(5),
};

impl LimitPolicy {
    /// Clamp a manifest's requested limits into this policy's range. Absent
    /// values take the default.
    pub fn resolve(&self, memory_bytes: Option<u64>, timeout_ms: Option<u64>) -> Limits {
        Limits {
            memory_bytes: clamp_bytes(
                memory_bytes,
                self.default_memory,
                self.min_memory,
                self.max_memory,
            ),
            timeout: clamp_duration(
                timeout_ms,
                self.default_timeout,
                self.min_timeout,
                self.max_timeout,
            ),
        }
    }
}

/// A requested byte count, or the default, clamped into `min..=max`.
pub fn clamp_bytes(requested: Option<u64>, default: usize, min: usize, max: usize) -> usize {
    requested
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default)
        .clamp(min, max)
}

/// A requested millisecond count, or the default, clamped into `min..=max`.
pub fn clamp_duration(
    requested_ms: Option<u64>,
    default: Duration,
    min: Duration,
    max: Duration,
) -> Duration {
    requested_ms
        .map(Duration::from_millis)
        .unwrap_or(default)
        .clamp(min, max)
}

/// How long native tools may run in total during one call, on top of the
/// plugin's own timeout.
pub const NATIVE_ALLOWANCE: Duration = Duration::from_secs(30);

/// The two deadlines of one call.
///
/// The script deadline is the plugin's own computing time. Time spent waiting
/// for a native tool is credited back to it, so a slow compile does not eat
/// the script's budget. The wall deadline is fixed when the call starts and
/// nothing extends it, so repeated tool runs cannot keep a call alive
/// forever.
#[derive(Debug)]
pub struct ExecutionBudget {
    script_deadline: Cell<Instant>,
    wall_deadline: Instant,
}

impl ExecutionBudget {
    pub fn start(timeout: Duration, native_allowance: Duration) -> Self {
        let started = Instant::now();
        Self {
            script_deadline: Cell::new(started + timeout),
            wall_deadline: started + timeout + native_allowance,
        }
    }

    /// [`HostError::Budget`] once either deadline has passed.
    pub fn check(&self) -> HostResult<()> {
        let now = Instant::now();
        if now >= self.script_deadline.get() || now >= self.wall_deadline {
            Err(HostError::Budget)
        } else {
            Ok(())
        }
    }

    /// The timeout to give one native tool run: what it asked for (default
    /// 10 s), clamped to 100 ms .. 30 s and to what is left of the wall
    /// deadline. Refuses to start a run that would not get its 100 ms minimum.
    pub fn native_timeout_ms(&self, requested: Option<u64>) -> HostResult<u64> {
        self.check()?;
        let remaining = self
            .wall_deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining < process::MIN_TIMEOUT_MS {
            return Err(HostError::Budget);
        }
        Ok(requested
            .unwrap_or(process::DEFAULT_TIMEOUT_MS)
            .clamp(process::MIN_TIMEOUT_MS, process::MAX_TIMEOUT_MS)
            .min(remaining))
    }

    /// Give the script back the time it spent waiting for a native tool.
    pub fn credit(&self, waited: Duration) {
        self.script_deadline
            .set(self.script_deadline.get() + waited);
    }

    pub fn wall_deadline(&self) -> Instant {
        self.wall_deadline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_limits_are_clamped_and_absent_ones_default() {
        assert_eq!(clamp_bytes(Some(999), 10, 1, 100), 100);
        assert_eq!(clamp_bytes(None, 10, 1, 100), 10);
        assert_eq!(clamp_bytes(Some(0), 10, 1, 100), 1);
        let ms = Duration::from_millis;
        assert_eq!(
            clamp_duration(Some(50), ms(1000), ms(100), ms(5000)),
            ms(100)
        );
        assert_eq!(clamp_duration(None, ms(1000), ms(100), ms(5000)), ms(1000));
    }

    #[test]
    fn policies_keep_their_documented_ranges() {
        let luau = LUAU.resolve(Some(1), Some(999_999));
        assert_eq!(luau.memory_bytes, MIB);
        assert_eq!(luau.timeout, Duration::from_secs(5));
        assert_eq!(LUAU.resolve(None, None).memory_bytes, 16 * MIB);

        let wasm = WASM.resolve(None, None);
        assert_eq!(wasm.memory_bytes, 32 * MIB);
        assert_eq!(wasm.timeout, Duration::from_secs(1));
        assert_eq!(WASM.resolve(Some(1), None).memory_bytes, 4 * MIB);
        let most = WASM.resolve(Some(u64::MAX), Some(u64::MAX));
        assert_eq!(most.timeout, Duration::from_secs(5));
        assert_eq!(most.memory_bytes, 256 * MIB);
    }

    #[test]
    fn native_time_credit_never_extends_the_absolute_deadline() {
        let now = Instant::now();
        let budget = ExecutionBudget {
            script_deadline: Cell::new(now + Duration::from_millis(500)),
            wall_deadline: now + Duration::from_millis(250),
        };
        assert!(budget.native_timeout_ms(Some(30_000)).unwrap() <= 250);
        // Repeated native calls can give all their time back to the script,
        // but cannot move the call's wall deadline.
        for _ in 0..1000 {
            budget.credit(Duration::from_secs(30));
        }
        assert!(budget.native_timeout_ms(None).unwrap() <= 250);
        let expired = ExecutionBudget {
            script_deadline: Cell::new(budget.script_deadline.get()),
            wall_deadline: now,
        };
        assert!(expired.check().is_err());
        assert!(expired.native_timeout_ms(None).is_err());
    }

    #[test]
    fn a_run_is_refused_when_less_than_its_minimum_is_left() {
        let now = Instant::now();
        let budget = ExecutionBudget {
            script_deadline: Cell::new(now + Duration::from_secs(10)),
            wall_deadline: now + Duration::from_millis(50),
        };
        assert!(matches!(
            budget.native_timeout_ms(None),
            Err(HostError::Budget)
        ));
    }

    #[test]
    fn a_fresh_budget_passes_its_check() {
        let budget = ExecutionBudget::start(Duration::from_secs(1), NATIVE_ALLOWANCE);
        assert!(budget.check().is_ok());
        assert!(budget.wall_deadline() > Instant::now());
    }
}
