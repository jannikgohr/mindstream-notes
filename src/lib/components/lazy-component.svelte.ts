import { untrack } from 'svelte';

// Call during component initialization. Load callbacks only import their module.
export function createLazyComponent<C>(options: {
  load: () => Promise<{ default: C }>;
  when: () => boolean;
  keepMountedWhenInactive?: boolean;
}) {
  let component = $state<C | null>(null);
  $effect(() => {
    // Read directly so active dependency changes also start a fresh request.
    const active = options.when();
    let current = true;
    if (!active) {
      if (!options.keepMountedWhenInactive) component = null;
    } else {
      void untrack(options.load).then(
        (module) => {
          if (current && options.when()) component = module.default;
        },
        (error: unknown) => {
          if (current && options.when()) {
            console.error('Failed to load lazy component', error);
          }
        }
      );
    }
    return () => {
      current = false;
    };
  });
  return {
    get component() {
      return component;
    }
  };
}
