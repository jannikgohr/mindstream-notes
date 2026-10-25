//! The memory and table caps of one call.
//!
//! Wasmtime's stock `StoreLimits` caps each linear memory on its own. A
//! component built from a language runtime can carry several memories, so
//! this limiter counts their sum against the plugin's `memoryBytes`, which is
//! the number a manifest author actually thinks in.

use wasmtime::ResourceLimiter;

/// Instances, tables and memories one component may create. A QuickJS
/// component needs about a dozen instances. These caps bound the host-side
/// bookkeeping of a component built to create thousands.
pub const MAX_INSTANCES: usize = 64;
pub const MAX_TABLES: usize = 64;
pub const MAX_MEMORIES: usize = 16;
/// Elements one table may grow to. Each costs the host a pointer.
pub const MAX_TABLE_ELEMENTS: usize = 1 << 20;

#[derive(Debug)]
pub struct CallLimiter {
    memory_limit: usize,
    memory_total: usize,
    exhausted: bool,
}

impl CallLimiter {
    pub fn new(memory_limit: usize) -> Self {
        Self {
            memory_limit,
            memory_total: 0,
            exhausted: false,
        }
    }

    /// Whether a growth was refused for going over the limit during this call.
    pub fn exhausted(&self) -> bool {
        self.exhausted
    }

    pub fn memory_total(&self) -> usize {
        self.memory_total
    }

    pub fn memory_limit(&self) -> usize {
        self.memory_limit
    }
}

impl ResourceLimiter for CallLimiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // `current` is already counted (creation reports 0 -> initial), so
        // the new total swaps it for `desired`.
        let next = self
            .memory_total
            .saturating_sub(current)
            .saturating_add(desired);
        if next > self.memory_limit {
            // Refusing makes `memory.grow` return -1, which a language
            // runtime turns into its own out-of-memory error rather than a
            // trap.
            self.exhausted = true;
            return Ok(false);
        }
        self.memory_total = next;
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= MAX_TABLE_ELEMENTS)
    }

    fn instances(&self) -> usize {
        MAX_INSTANCES
    }

    fn tables(&self) -> usize {
        MAX_TABLES
    }

    fn memories(&self) -> usize {
        MAX_MEMORIES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memories_are_counted_together() {
        let mut limiter = CallLimiter::new(100);
        assert!(limiter.memory_growing(0, 60, None).unwrap());
        assert!(limiter.memory_growing(0, 30, None).unwrap());
        assert_eq!(limiter.memory_total(), 90);
        // The first memory growing from 60 to 75 would make 105.
        assert!(!limiter.memory_growing(60, 75, None).unwrap());
        assert!(limiter.exhausted());
        assert_eq!(limiter.memory_total(), 90);
        assert!(limiter.memory_growing(60, 70, None).unwrap());
        assert_eq!(limiter.memory_total(), 100);
        assert_eq!(limiter.memory_limit(), 100);
    }

    #[test]
    fn tables_and_counts_are_capped() {
        let mut limiter = CallLimiter::new(0);
        assert!(limiter.table_growing(0, MAX_TABLE_ELEMENTS, None).unwrap());
        assert!(!limiter
            .table_growing(0, MAX_TABLE_ELEMENTS + 1, None)
            .unwrap());
        assert_eq!(limiter.instances(), MAX_INSTANCES);
        assert_eq!(limiter.tables(), MAX_TABLES);
        assert_eq!(limiter.memories(), MAX_MEMORIES);
    }
}
