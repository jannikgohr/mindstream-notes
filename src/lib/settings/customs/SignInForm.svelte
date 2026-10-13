<script lang="ts">
  /**
   * Sign-in, signup, recovery and sign-out panel. Only mounted when the
   * surrounding `account.serverType` is "managed" or "self-hosted" (see
   * schema.json).
   *
   * Rendering branches:
   *   - a recovery key waiting to be acknowledged → the key, nothing else
   *   - signed in  → "Signed in as X" + server URL + sync/logout
   *   - signed out → the server (fixed for managed, an input for
   *                  self-hosted) and one of three forms: sign in, create
   *                  an account, or get back in with a recovery key
   *
   * The URL field used to live as its own setting in schema.json. Moving
   * it in here means the user only sees it where it's actually relevant
   * (the sign-in flow), and we can lock it implicitly once signed in by
   * just not rendering the input — the value the user actually used is
   * shown in the signed-in card below.
   *
   * The Rust side stashes the encrypted session on disk and the
   * encryption key in the OS keystore — see src-tauri/src/auth/mod.rs.
   * We never send the password anywhere, the server included: what goes
   * out is a signature made with a key derived from it. And we never
   * persist it.
   */
  import {
    parseInviteLink,
    sameServer,
    serverName
  } from '$lib/sharing/invite-link';
  import { Button } from '$lib/components/ui/button';
  import { CheckCircle2, LogOut, Loader2, RefreshCw } from '@lucide/svelte';
  import {
    accountRecover,
    accountServerInfo,
    accountSignup,
    type ServerInfo,
    type ServerTarget
  } from '$lib/api/account';
  import {
    adoptSession,
    authSession,
    checkEtebaseServerUrl,
    etebaseLogin,
    etebaseLogout,
    refreshAuthSession,
    MANAGED_SERVER_URL,
    type ServerType
  } from '$lib/api/auth.svelte';
  import { type SyncReport } from '$lib/api/sync';
  import { normalizeServerUrl } from '$lib/api/server-urls';
  import SecretReveal from '$lib/account/SecretReveal.svelte';
  import { pendingReveal } from '$lib/account/pending-reveal.svelte';
  import {
    describeRefusal,
    refusalReason,
    REASON_CODE_REQUIRED
  } from '$lib/account/refusal';
  import {
    FIELD_CLASS,
    FIELD_LABEL_CLASS,
    MIN_PASSWORD_LENGTH
  } from '$lib/account/styles';
  import { upsertNotification } from '$lib/notifications/store.svelte';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { summariseSyncReport } from '$lib/sync/report-summary';
  import { runSync } from '$lib/sync/runner';
  import {
    getSettingValue,
    setSettingValue,
    settingsDialog
  } from '../store.svelte';

  type Mode = 'signin' | 'signup' | 'recover';

  let mode = $state<Mode>('signin');
  let username = $state('');
  let email = $state('');
  let password = $state('');
  let passwordAgain = $state('');
  let code = $state('');
  /** The server has said the account needs a code. Shown from then on. */
  let codeNeeded = $state(false);
  let signupCode = $state('');
  let recoveryKey = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let syncing = $state(false);
  let lastReport = $state<SyncReport | null>(null);
  let checkingUrl = $state(false);
  let checkUrlStatus = $state<string | null>(null);
  let checkUrlOk = $state(false);
  /** What the server said about itself, for the signup form. Null until
   *  asked, and again when it could not be asked. */
  let serverInfo = $state<ServerInfo | null>(null);

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

  const serverReady = $derived(
    serverType === 'managed' ||
      (serverType === 'self-hosted' &&
        serverUrlValidation.url.length > 0 &&
        serverUrlValidation.error === null)
  );

  const target = $derived<ServerTarget>({
    serverType: serverType as ServerType,
    serverUrl:
      serverType === 'self-hosted' ? serverUrlValidation.url : undefined
  });

  /** What is wrong with the new password, if anything worth saying yet. */
  const passwordProblem = $derived.by(() => {
    if (mode === 'signin' || password.length === 0) return null;
    if (password.length < MIN_PASSWORD_LENGTH) {
      return tUiFormat('account.password.tooShort', {
        count: MIN_PASSWORD_LENGTH
      });
    }
    if (passwordAgain.length > 0 && password !== passwordAgain) {
      return tUi('account.password.mismatch');
    }
    return null;
  });

  const newPasswordReady = $derived(
    password.length >= MIN_PASSWORD_LENGTH && password === passwordAgain
  );

  /** A server that takes anyone needs no code. One this app could not ask
   *  gets the field anyway, left optional. */
  const signupCodeShown = $derived(
    serverInfo?.signup !== 'open' || signupCode.trim().length > 0
  );
  const signupCodeRequired = $derived(
    serverInfo !== null && serverInfo.signup !== 'open'
  );
  /** What is in the code field, if it is an invite link and not a code. A
   *  link is good on one server, so it only counts for the one above. */
  const signupLink = $derived(
    mode === 'signup' ? parseInviteLink(signupCode) : null
  );
  const signupLinkElsewhere = $derived(
    signupLink !== null &&
      !sameServer(
        signupLink.serverUrl,
        serverType === 'managed' ? MANAGED_SERVER_URL : serverUrlValidation.url
      )
  );

  const canSubmit = $derived.by(() => {
    if (busy || !serverReady || username.trim().length === 0) return false;
    switch (mode) {
      case 'signin':
        return password.length > 0;
      case 'signup':
        return (
          newPasswordReady &&
          email.trim().length > 0 &&
          !signupLinkElsewhere &&
          (!signupCodeRequired || signupCode.trim().length > 0)
        );
      case 'recover':
        return newPasswordReady && recoveryKey.trim().length > 0;
    }
  });

  // Re-check whenever the settings dialog opens — covers the case where
  // a different window signed in or logged out while this one was idle.
  $effect(() => {
    if (settingsDialog.open) void refreshAuthSession();
  });

  // The signup form asks for a code only where the server wants one, so
  // it has to ask the server first. Asked again when the address changes.
  $effect(() => {
    if (mode !== 'signup' || !serverReady) {
      serverInfo = null;
      return;
    }
    const asked = target;
    let stale = false;
    accountServerInfo(asked)
      .then((info) => {
        if (!stale) serverInfo = info;
      })
      .catch((err) => {
        if (stale) return;
        serverInfo = null;
        error = describeRefusal(err);
      });
    return () => {
      stale = true;
    };
  });

  function switchMode(next: Mode) {
    mode = next;
    error = null;
    password = '';
    passwordAgain = '';
    code = '';
    codeNeeded = false;
  }

  function notify(id: string, title: string, message: string) {
    upsertNotification({
      id: `auth:${id}:${Date.now()}`,
      kind: 'generic',
      widgetType: 'generic',
      createdAt: Date.now(),
      data: { title, message }
    });
  }

  /** Persist the cleaned-up URL back so the next time the user opens
   *  settings they see the form the app actually uses. Only after the
   *  server accepted something: a network failure or wrong password
   *  doesn't prove the URL was right, and rewriting on failure would
   *  feel intrusive. */
  async function keepNormalizedUrl() {
    const normalizedUrl = serverUrlValidation.url;
    if (
      serverType !== 'self-hosted' ||
      !normalizedUrl ||
      normalizedUrl === serverUrlInput.trim()
    ) {
      return;
    }
    try {
      await setSettingValue('account.serverUrl', normalizedUrl);
    } catch (err) {
      console.warn('[auth] persist normalized server URL', err);
    }
  }

  /** Point the form at the server an invite link belongs to. */
  async function useLinkServer() {
    if (!signupLink) return;
    try {
      if (sameServer(signupLink.serverUrl, MANAGED_SERVER_URL)) {
        await setSettingValue('account.serverType', 'managed');
      } else {
        await setSettingValue('account.serverType', 'self-hosted');
        await setSettingValue('account.serverUrl', signupLink.serverUrl);
      }
    } catch (err) {
      console.warn('[auth] use the server of an invite link', err);
    }
  }

  /** The server asked for a code: show the field and say so, as a prompt
   *  and not as a failure. */
  function askForCode(err: unknown): boolean {
    if (refusalReason(err) !== REASON_CODE_REQUIRED || codeNeeded) {
      return false;
    }
    codeNeeded = true;
    error = null;
    return true;
  }

  async function signIn() {
    const connectedTo =
      serverType === 'self-hosted'
        ? serverUrlValidation.url
        : MANAGED_SERVER_URL;
    await etebaseLogin({
      ...target,
      username: username.trim(),
      password,
      code: codeNeeded ? code : undefined
    });
    notify(
      'signin',
      tUi('account.notify.signedIn.title'),
      tUiFormat('account.notify.signedIn.message', { server: connectedTo })
    );
    password = '';
    username = '';
    await keepNormalizedUrl();
  }

  async function signUp() {
    const created = await accountSignup({
      ...target,
      username: username.trim(),
      email: email.trim(),
      password,
      // The field takes either. A link also joins what it leads to.
      signupCode: signupLink === null ? signupCode : undefined,
      inviteLink: signupLink === null ? undefined : signupCode.trim()
    });
    await keepNormalizedUrl();
    pendingReveal.current = created;
  }

  async function recover() {
    const recovered = await accountRecover({
      ...target,
      username: username.trim(),
      recoveryKey,
      newPassword: password,
      code: codeNeeded ? code : undefined
    });
    await keepNormalizedUrl();
    pendingReveal.current = recovered;
  }

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    error = null;
    try {
      if (mode === 'signin') await signIn();
      else if (mode === 'signup') await signUp();
      else await recover();
    } catch (err) {
      if (!askForCode(err)) error = describeRefusal(err);
    } finally {
      busy = false;
    }
  }

  /** The key is stored: take the session over, which reloads the window. */
  function finishReveal() {
    const revealed = pendingReveal.current;
    if (!revealed) return;
    pendingReveal.current = null;
    password = '';
    passwordAgain = '';
    recoveryKey = '';
    adoptSession(revealed.session);
  }

  async function signOut() {
    busy = true;
    error = null;
    try {
      await etebaseLogout();
      notify(
        'signout',
        tUi('account.notify.signedOut.title'),
        tUi('account.notify.signedOut.message')
      );
      lastReport = null;
    } catch (err) {
      error = describeRefusal(err);
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
      error = describeRefusal(err);
    } finally {
      syncing = false;
    }
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
        ? tUiFormat('account.server.replied', { url: result.url })
        : tUiFormat('account.server.unhealthy', {
            status: result.status,
            url: result.url
          });
    } catch (err) {
      checkUrlStatus = null;
      error = describeRefusal(err);
    } finally {
      checkingUrl = false;
    }
  }
</script>

<div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
  {#if pendingReveal.current}
    <SecretReveal
      title={tUi('account.reveal.recoveryKey.title')}
      explanation={tUi('account.reveal.recoveryKey.explanation')}
      lines={[pendingReveal.current.recoveryKey]}
      onDone={finishReveal}
    />
  {:else if !authSession.initialised}
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      {tUi('account.session.checking')}
    </div>
  {:else if authSession.current}
    <div class="grid gap-2">
      <div>
        <div class="text-xs uppercase tracking-wide text-muted-foreground">
          {tUi('account.session.signedIn')}
        </div>
        <div class="mt-1 font-medium" data-testid="account-username">
          {authSession.current.username}
        </div>
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
            {tUi('account.session.syncing')}
          {:else}
            <RefreshCw class="mr-1.5 size-3.5" />
            {tUi('account.session.syncNow')}
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
            {tUi('account.session.loggingOut')}
          {:else}
            <LogOut class="mr-1.5 size-3.5" />
            {tUi('account.session.logOut')}
          {/if}
        </Button>
      </div>
      {#if lastReport && !error}
        <p class="text-xs text-muted-foreground">
          {summariseSyncReport(lastReport)}
        </p>
      {/if}
      {#if error}
        <p class="text-xs text-destructive">{error}</p>
      {/if}
    </div>
  {:else}
    <div>
      <form
        class="grid gap-2"
        data-testid="account-form"
        data-mode={mode}
        onsubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {#if serverType === 'self-hosted'}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.serverUrl')}</span>
            <div class="flex gap-2">
              <input
                type="url"
                inputmode="url"
                autocomplete="url"
                aria-label={tUi('account.serverUrl')}
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
                  {tUi('account.server.checking')}
                {:else}
                  {tUi('account.server.check')}
                {/if}
              </Button>
            </div>
          </label>
        {:else if serverType === 'managed'}
          <div class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.server.label')}</span>
            <div
              class="flex h-8 items-center rounded-md border border-input bg-background/40 px-2 font-mono text-xs text-muted-foreground"
              title={tUi('account.managedHint')}
            >
              {tUiFormat('account.server.managed', { url: MANAGED_SERVER_URL })}
            </div>
          </div>
        {/if}

        {#if mode === 'signup'}
          <p class="text-xs text-muted-foreground">
            {tUi('account.signup.explanation')}
          </p>
        {:else if mode === 'recover'}
          <p class="text-xs text-muted-foreground">
            {tUi('account.recover.explanation')}
          </p>
        {/if}

        <label class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>{tUi('account.username')}</span>
          <input
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            aria-label={tUi('account.username')}
            bind:value={username}
            disabled={busy}
            class={FIELD_CLASS}
          />
        </label>

        {#if mode === 'signup'}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.email')}</span>
            <input
              type="email"
              autocomplete="email"
              aria-label={tUi('account.email')}
              bind:value={email}
              placeholder="you@example.com"
              disabled={busy}
              class={FIELD_CLASS}
            />
          </label>
        {/if}

        {#if mode === 'recover'}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.recoveryKey')}</span>
            <textarea
              rows="2"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              aria-label={tUi('account.recoveryKey')}
              bind:value={recoveryKey}
              placeholder="ABCD-EFGH-…"
              disabled={busy}
              class="w-full resize-none rounded-md border border-input bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            ></textarea>
          </label>
        {/if}

        <label class="grid gap-1">
          <span class={FIELD_LABEL_CLASS}>
            {tUi(
              mode === 'recover' ? 'account.newPassword' : 'account.password'
            )}
          </span>
          <input
            type="password"
            autocomplete={mode === 'signin'
              ? 'current-password'
              : 'new-password'}
            aria-label={tUi(
              mode === 'recover' ? 'account.newPassword' : 'account.password'
            )}
            bind:value={password}
            disabled={busy}
            class={FIELD_CLASS}
          />
        </label>

        {#if mode !== 'signin'}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.passwordAgain')}</span
            >
            <input
              type="password"
              autocomplete="new-password"
              aria-label={tUi('account.passwordAgain')}
              bind:value={passwordAgain}
              disabled={busy}
              class={FIELD_CLASS}
            />
          </label>
          {#if passwordProblem}
            <p class="text-xs text-destructive">{passwordProblem}</p>
          {/if}
        {/if}

        {#if mode === 'signup' && signupCodeShown}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.signupCode')}</span>
            <input
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              aria-label={tUi('account.signupCode')}
              bind:value={signupCode}
              disabled={busy}
              class="{FIELD_CLASS} font-mono"
            />
            {#if !signupLinkElsewhere}
              <span class="text-xs text-muted-foreground">
                {tUi(
                  signupLink
                    ? 'account.signupLink.hint'
                    : 'account.signupCode.hint'
                )}
              </span>
            {/if}
          </label>
          <!-- Outside the label, so the button is not part of the field's
               name and a click on it does not land in the field. -->
          {#if signupLinkElsewhere && signupLink}
            <div class="grid gap-1" data-testid="signup-link-elsewhere">
              <p class="text-xs text-destructive">
                {tUiFormat('account.signupLink.elsewhere', {
                  server: serverName(signupLink.serverUrl)
                })}
              </p>
              <button
                type="button"
                class="justify-self-start text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
                onclick={() => void useLinkServer()}
              >
                {tUiFormat('account.signupLink.useServer', {
                  server: serverName(signupLink.serverUrl)
                })}
              </button>
            </div>
          {/if}
        {/if}

        {#if codeNeeded && mode !== 'signup'}
          <label class="grid gap-1">
            <span class={FIELD_LABEL_CLASS}>{tUi('account.code')}</span>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              autofocus
              aria-label={tUi('account.code')}
              bind:value={code}
              disabled={busy}
              class="{FIELD_CLASS} font-mono"
            />
            <span class="text-xs text-muted-foreground">
              {tUi('account.code.hint')}
            </span>
          </label>
        {/if}

        <div class="flex items-center justify-between gap-3 pt-1">
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {#if busy}
              <Loader2 class="mr-1.5 size-3.5 animate-spin" />
              {tUi(`account.${mode}.busy`)}
            {:else}
              {tUi(`account.${mode}.submit`)}
            {/if}
          </Button>
          {#if error}
            <span class="text-xs text-destructive" data-testid="account-error">
              {error}
            </span>
          {:else if serverType === 'self-hosted' && serverUrlError}
            <span class="text-xs text-destructive">{serverUrlError}</span>
          {:else if serverType === 'self-hosted' && !serverUrlValidation.url}
            <span class="text-xs text-muted-foreground">
              {tUi('account.server.enterFirst')}
            </span>
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

        <div class="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
          {#if mode === 'signin'}
            <button
              type="button"
              class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onclick={() => switchMode('signup')}
              disabled={busy}
            >
              {tUi('account.mode.signup')}
            </button>
            <button
              type="button"
              class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onclick={() => switchMode('recover')}
              disabled={busy}
            >
              {tUi('account.mode.recover')}
            </button>
          {:else}
            <button
              type="button"
              class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onclick={() => switchMode('signin')}
              disabled={busy}
            >
              {tUi('account.mode.signin')}
            </button>
          {/if}
        </div>
      </form>
    </div>
  {/if}
</div>
