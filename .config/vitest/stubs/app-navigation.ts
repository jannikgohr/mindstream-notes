/**
 * Test stub for SvelteKit's `$app/navigation` virtual module.
 *
 * Vitest uses the plain Svelte plugin (not @sveltejs/kit/vite), so the
 * `$app/*` virtual modules don't exist during transform and any source
 * file importing them fails to resolve before a `vi.mock` factory can run.
 * vitest.config.ts aliases `$app/navigation` here so those imports resolve;
 * individual tests still `vi.mock('$app/navigation', …)` when they need to
 * assert on the calls.
 */

export function pushState(..._args: unknown[]): void {}
export function replaceState(..._args: unknown[]): void {}
export function goto(..._args: unknown[]): Promise<void> {
  return Promise.resolve();
}
export function invalidateAll(): Promise<void> {
  return Promise.resolve();
}
export function afterNavigate(): void {}
export function beforeNavigate(): void {}
