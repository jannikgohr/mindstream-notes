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
  import { LogOut, Loader2, RefreshCw } from 'lucide-svelte';
  import {
    etebaseLogin,
    etebaseLogout,
    etebaseSession,
    type ServerType,
    type SessionInfo
  } from '$lib/api/auth';
  import { type SyncReport } from '$lib/api/sync';
  import { runSync } from '$lib/sync/runner';
  import { getSettingValue, settingsDialog } from '../store.svelte';

  let session = $state<SessionInfo | null>(null);
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let initialised = $state(false);
  let syncing = $state(false);
  let lastReport = $state<SyncReport | null>(null);

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
      lastReport = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function triggerSync() {
    if (syncing) return;
    syncing = true;
    error = null;
    try {
      lastReport = await runSync();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      syncing = false;
    }
  }

  function summarise(r: SyncReport): string {
    const parts: string[] = [];
    if (r.notes_pulled || r.folders_pulled) {
      parts.push(`pulled ${r.notes_pulled} note${r.notes_pulled === 1 ? '' : 's'}, ${r.folders_pulled} folder${r.folders_pulled === 1 ? '' : 's'}`);
    }
    if (r.notes_pushed || r.folders_pushed) {
      parts.push(`pushed ${r.notes_pushed} note${r.notes_pushed === 1 ? '' : 's'}, ${r.folders_pushed} folder${r.folders_pushed === 1 ? '' : 's'}`);
    }
    if (r.conflicts_resolved) {
      parts.push(`${r.conflicts_resolved} conflict${r.conflicts_resolved === 1 ? '' : 's'} merged`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'Already up to date';
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
      <div class="flex items-center gap-2 pt-1">
        <Button size="sm" onclick={triggerSync} disabled={syncing || busy}>
          {#if syncing}
            <Loader2 class="mr-1.5 size-3.5 animate-spin" />
            Syncing…
          {:else}
            <RefreshCw class="mr-1.5 size-3.5" />
            Sync now
          {/if}
        </Button>
        <Button size="sm" variant="destructive" onclick={signOut} disabled={busy || syncing}>
          {#if busy}
            <Loader2 class="mr-1.5 size-3.5 animate-spin" />
            Logging out…
          {:else}
            <LogOut class="mr-1.5 size-3.5" />
            Log out
          {/if}
        </Button>
      </div>
      {#if lastReport && !error}
        <p class="text-xs text-muted-foreground">{summarise(lastReport)}</p>
      {/if}
      {#if error}
        <p class="text-xs text-destructive">{error}</p>
      {/if}
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
