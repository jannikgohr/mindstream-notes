<script lang="ts">
  /**
   * Etebase sign-in / sign-out panel. Only mounted when the surrounding
   * `account.serverType` is "managed" or "self-hosted" (see schema.json).
   *
   * The Rust side stashes the encrypted session on disk and the encryption
   * key in the OS keystore — see src-tauri/src/auth/mod.rs. We never send
   * the password anywhere except the etebase server, and never persist it.
   */
  import { Button } from '$lib/components/ui/button';
  import { LogOut, Loader2 } from 'lucide-svelte';
  import {
    etebaseLogin,
    etebaseLogout,
    etebaseSession,
    type ServerType,
    type SessionInfo
  } from '$lib/api/auth';
  import { getSettingValue, settingsDialog } from '../store.svelte';

  let session = $state<SessionInfo | null>(null);
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let initialised = $state(false);

  const serverType = $derived(
    (getSettingValue('account.serverType') as string | undefined) ?? 'local-only'
  );
  const serverUrl = $derived(
    ((getSettingValue('account.serverUrl') as string | undefined) ?? '').trim()
  );

  const canSubmit = $derived(
    !busy &&
      username.trim().length > 0 &&
      password.length > 0 &&
      (serverType === 'managed' ||
        (serverType === 'self-hosted' && serverUrl.length > 0))
  );

  async function refresh() {
    try {
      session = await etebaseSession();
    } catch (err) {
      console.warn('[auth] session check failed', err);
      session = null;
    } finally {
      initialised = true;
    }
  }

  // Re-check whenever the settings dialog opens — covers the case where
  // a different window signed in or logged out while this one was idle.
  $effect(() => {
    if (settingsDialog.open) void refresh();
  });

  async function signIn() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    try {
      session = await etebaseLogin({
        serverType: serverType as ServerType,
        serverUrl: serverType === 'self-hosted' ? serverUrl : undefined,
        username: username.trim(),
        password
      });
      password = '';
      username = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function signOut() {
    busy = true;
    error = null;
    try {
      await etebaseLogout();
      session = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
  {#if !initialised}
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      Checking session…
    </div>
  {:else if session}
    <div class="grid gap-2">
      <div>
        <div class="text-xs uppercase tracking-wide text-muted-foreground">
          Signed in
        </div>
        <div class="mt-1 font-medium">{session.username}</div>
        <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={session.server_url}>
          {session.server_url}
        </div>
      </div>
      <div class="flex items-center gap-3 pt-1">
        <Button size="sm" variant="destructive" onclick={signOut} disabled={busy}>
          {#if busy}
            <Loader2 class="mr-1.5 size-3.5 animate-spin" />
            Logging out…
          {:else}
            <LogOut class="mr-1.5 size-3.5" />
            Log out
          {/if}
        </Button>
        {#if error}
          <span class="text-xs text-destructive">{error}</span>
        {/if}
      </div>
    </div>
  {:else}
    <form class="grid gap-2" onsubmit={(e) => { e.preventDefault(); void signIn(); }}>
      <label class="grid gap-1">
        <span class="text-xs text-muted-foreground">Username or email</span>
        <input
          type="text"
          autocomplete="username"
          bind:value={username}
          placeholder="you@example.com"
          disabled={busy}
          class="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </label>
      <label class="grid gap-1">
        <span class="text-xs text-muted-foreground">Password</span>
        <input
          type="password"
          autocomplete="current-password"
          bind:value={password}
          disabled={busy}
          class="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </label>
      <div class="flex items-center justify-between gap-3 pt-1">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {#if busy}
            <Loader2 class="mr-1.5 size-3.5 animate-spin" />
            Signing in…
          {:else}
            Sign in
          {/if}
        </Button>
        {#if error}
          <span class="text-xs text-destructive">{error}</span>
        {:else if serverType === 'self-hosted' && !serverUrl}
          <span class="text-xs text-muted-foreground">Set a server URL above first.</span>
        {/if}
      </div>
    </form>
  {/if}
</div>
