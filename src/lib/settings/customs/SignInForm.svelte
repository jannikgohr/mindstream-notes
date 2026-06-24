<script lang="ts">
  /**
   * Etebase sign-in / sign-out panel. Only mounted when the surrounding
   * `account.serverType` is "managed" or "self-hosted" (see schema.json).
   *
   * Three rendering branches:
   *   - signed in  → "Signed in as X" + server URL + sync/logout
   *   - signed out, managed     → fixed "Managed (api.mindstream-notes.invalid)" label,
   *                                creds, submit
   *   - signed out, self-hosted → URL input + creds + submit
   *
   * The URL field used to live as its own setting in schema.json. Moving
   * it in here means the user only sees it where it's actually relevant
   * (the sign-in flow), and we can lock it implicitly once signed in by
   * just not rendering the input — the value the user actually used is
   * shown in the signed-in card below.
   *
   * The Rust side stashes the encrypted session on disk and the
   * encryption key in the OS keystore — see src-tauri/src/auth/mod.rs.
   * We never send the password anywhere except the etebase server, and
   * never persist it.
   */
  import { Button } from '$lib/components/ui/button';
  import { CheckCircle2, LogOut, Loader2, RefreshCw } from '@lucide/svelte';
  import {
    authSession,
    checkEtebaseServerUrl,
    etebaseLogin,
    etebaseLogout,
    refreshAuthSession,
    type ServerType
  } from '$lib/api/auth.svelte';
  import { type SyncReport } from '$lib/api/sync';
  import { normalizeServerUrl } from '$lib/api/server-urls';
  import { upsertNotification } from '$lib/notifications/store.svelte';
  import { runSync } from '$lib/sync/runner';
  import {
    getSettingValue,
    setSettingValue,
    settingsDialog
  } from '../store.svelte';

  /** What "managed" mode is bound to. Mirrors MANAGED_SERVER_URL in
   *  src-tauri/src/auth/mod.rs — keep both in sync when changing. */
  const MANAGED_SERVER_URL = 'https://api.mindstream-notes.invalid/';

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let syncing = $state(false);
  let lastReport = $state<SyncReport | null>(null);
  let checkingUrl = $state(false);
  let checkUrlStatus = $state<string | null>(null);
  let checkUrlOk = $state(false);

  const serverType = $derived(
    (getSettingValue('account.serverType') as string | undefined) ??
      'local-only'
  );
  /** Raw input as the user typed it — kept verbatim so the field
   *  doesn't fight them mid-typing. The submit path uses the
   *  normalised value below. */
  const serverUrlInput = $derived(
    (getSettingValue('account.serverUrl') as string | undefined) ?? ''
  );
  /** Result of running the raw input through the normaliser:
   *  canonical origin URL when parseable, plus an inline error
   *  string when the user typed something we can't accept. */
  const serverUrlValidation = $derived(normalizeServerUrl(serverUrlInput));
  /** Only surface the validation error once the user has actually
   *  typed something — an empty field is "not yet configured",
   *  which is the prompt below, not an error. */
  const serverUrlError = $derived(
    serverUrlInput.trim().length > 0 ? serverUrlValidation.error : null
  );

  const canSubmit = $derived(
    !busy &&
      username.trim().length > 0 &&
      password.length > 0 &&
      (serverType === 'managed' ||
        (serverType === 'self-hosted' &&
          serverUrlValidation.url.length > 0 &&
          serverUrlValidation.error === null))
  );

  // Re-check whenever the settings dialog opens — covers the case where
  // a different window signed in or logged out while this one was idle.
  $effect(() => {
    if (settingsDialog.open) void refreshAuthSession();
  });

  async function signIn() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    const normalizedUrl = serverUrlValidation.url;
    try {
      await etebaseLogin({
        serverType: serverType as ServerType,
        serverUrl: serverType === 'self-hosted' ? normalizedUrl : undefined,
        username: username.trim(),
        password
      });
      upsertNotification({
        id: `auth:signin:${Date.now()}`,
        kind: 'generic',
        widgetType: 'generic',
        createdAt: Date.now(),
        data: {
          title: 'Signed in',
          message: `Connected to ${serverType === 'self-hosted' ? normalizedUrl : MANAGED_SERVER_URL}`
        }
      });
      password = '';
      username = '';
      // Persist the cleaned-up URL back so the next time the user
      // opens settings they see the form the app actually uses. We
      // only do this after a successful login: a network failure or
      // wrong password doesn't prove the URL was right, and rewriting
      // on failure would feel intrusive.
      if (
        serverType === 'self-hosted' &&
        normalizedUrl &&
        normalizedUrl !== serverUrlInput.trim()
      ) {
        try {
          await setSettingValue('account.serverUrl', normalizedUrl);
        } catch (err) {
          console.warn('[auth] persist normalized server URL', err);
        }
      }
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
      upsertNotification({
        id: `auth:signout:${Date.now()}`,
        kind: 'generic',
        widgetType: 'generic',
        createdAt: Date.now(),
        data: {
          title: 'Signed out',
          message: 'Your local session was cleared.'
        }
      });
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
      parts.push(
        `pulled ${r.notes_pulled} note${r.notes_pulled === 1 ? '' : 's'}, ${r.folders_pulled} folder${r.folders_pulled === 1 ? '' : 's'}`
      );
    }
    if (r.notes_pushed || r.folders_pushed) {
      parts.push(
        `pushed ${r.notes_pushed} note${r.notes_pushed === 1 ? '' : 's'}, ${r.folders_pushed} folder${r.folders_pushed === 1 ? '' : 's'}`
      );
    }
    if (r.conflicts_resolved) {
      parts.push(
        `${r.conflicts_resolved} conflict${r.conflicts_resolved === 1 ? '' : 's'} merged`
      );
    }
    return parts.length > 0 ? parts.join(' · ') : 'Already up to date';
  }

  /** Two-way binding for the URL input. We can't `bind:value` against a
   *  `$derived` (it's read-only by design), so the input drives
   *  setSettingValue and reads back through the same derived store. */
  function onServerUrlInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    checkUrlStatus = null;
    checkUrlOk = false;
    void setSettingValue('account.serverUrl', target.value);
  }

  async function checkUrl() {
    if (
      checkingUrl ||
      serverType !== 'self-hosted' ||
      !serverUrlValidation.url ||
      serverUrlValidation.error
    ) {
      return;
    }
    checkingUrl = true;
    error = null;
    checkUrlStatus = null;
    checkUrlOk = false;
    try {
      const result = await checkEtebaseServerUrl(serverUrlValidation.url);
      checkUrlOk = result.ok;
      checkUrlStatus = result.ok
        ? `Server replied at ${result.url}`
        : `Health check returned HTTP ${result.status} at ${result.url}`;
    } catch (err) {
      checkUrlStatus = null;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      checkingUrl = false;
    }
  }
</script>

<div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
  {#if !authSession.initialised}
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      Checking session…
    </div>
  {:else if authSession.current}
    <div class="grid gap-2">
      <div>
        <div class="text-xs uppercase tracking-wide text-muted-foreground">
          Signed in
        </div>
        <div class="mt-1 font-medium">{authSession.current.username}</div>
        <div
          class="mt-0.5 truncate font-mono text-xs text-muted-foreground"
          title={authSession.current.server_url}
        >
          {authSession.current.server_url}
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
        <Button
          size="sm"
          variant="destructive"
          onclick={signOut}
          disabled={busy || syncing}
        >
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
    <form
      class="grid gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        void signIn();
      }}
    >
      {#if serverType === 'self-hosted'}
        <label class="grid gap-1">
          <span class="text-xs text-muted-foreground">Server URL</span>
          <div class="flex gap-2">
            <input
              type="url"
              inputmode="url"
              autocomplete="url"
              value={serverUrlInput}
              oninput={onServerUrlInput}
              placeholder="https://collab.example.com"
              disabled={busy}
              class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onclick={checkUrl}
              disabled={busy ||
                checkingUrl ||
                !serverUrlValidation.url ||
                serverUrlValidation.error !== null}
            >
              {#if checkingUrl}
                <Loader2 class="mr-1.5 size-3.5 animate-spin" />
                Checking…
              {:else}
                Check URL
              {/if}
            </Button>
          </div>
        </label>
      {:else if serverType === 'managed'}
        <div class="grid gap-1">
          <span class="text-xs text-muted-foreground">Server</span>
          <div
            class="flex h-8 items-center rounded-md border border-input bg-background/40 px-2 font-mono text-xs text-muted-foreground"
            title="Managed by Etebase. Switch to self-hosted in the radio above to use your own server."
          >
            Managed ({MANAGED_SERVER_URL})
          </div>
        </div>
      {/if}
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
        {:else if serverType === 'self-hosted' && serverUrlError}
          <span class="text-xs text-destructive">{serverUrlError}</span>
        {:else if serverType === 'self-hosted' && !serverUrlValidation.url}
          <span class="text-xs text-muted-foreground"
            >Enter your server URL above first.</span
          >
        {:else if serverType === 'self-hosted' && checkUrlStatus}
          <span
            class="inline-flex items-center gap-1 text-xs {checkUrlOk
              ? 'text-muted-foreground'
              : 'text-destructive'}"
          >
            <CheckCircle2
              class="size-3.5 {checkUrlOk
                ? 'text-primary'
                : 'text-destructive'}"
            />
            {checkUrlStatus}
          </span>
        {/if}
      </div>
    </form>
  {/if}
</div>
