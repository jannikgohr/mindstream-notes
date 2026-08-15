<script lang="ts">
  /**
   * Host-owned settings section that lets the user verify a plugin's declared
   * text checkers can reach their server. Rendered inside a plugin's own
   * settings pane whenever it declares `contributes.textCheckers`, and built
   * to match {@link PluginNativeToolsSection}: same row shape, same Check
   * button, same inline result. A checker's server and a plugin's native
   * binary are the same question to the user — "is the thing this needs
   * actually there?" — so they should not answer it two different ways.
   *
   * Reachability is probed via the endpoint the checker's own protocol
   * declares for it, which carries no note text; credentials, when configured,
   * are verified with a fixed probe string. See `spellcheck::http_checker` for
   * why.
   */
  import {
    CheckCircle2,
    CircleDashed,
    Globe,
    RefreshCw,
    XCircle
  } from '@lucide/svelte';
  import { textCheckerTestConnection } from '$lib/api/spellcheck';
  import { checkerStatus } from '$lib/diagnostics/checker-status.svelte';
  import { checkerProviderId } from '$lib/diagnostics/plugin-checkers.svelte';
  import {
    selectedLanguageTags,
    spellingOwner
  } from '$lib/diagnostics/editor-diagnostics.svelte';
  import { pluginById } from '$lib/plugins/registry.svelte';
  import type { PluginTextCheckerContribution } from '$lib/plugins/types';
  import { resolvePluginStringOptional } from '$lib/plugins/plugin-i18n';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    pluginId: string;
  }
  let { pluginId }: Props = $props();

  const checkers = $derived(
    pluginById(pluginId)?.manifest.contributes.textCheckers ?? []
  );

  type RowState = 'idle' | 'checking' | 'ok' | 'failed';
  interface Row {
    state: RowState;
    detail: string | null;
  }
  let rows = $state<Record<string, Row>>({});

  function setting(id: string): string | undefined {
    const value = getSettingValue(`plugins.${pluginId}.${id}`);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  // Takes the whole contribution rather than picked-apart fields: the request
  // now needs the declared protocol too, and threading one more argument
  // through each call site is how the last one drifted out of sync.
  async function check(checker: PluginTextCheckerContribution) {
    const checkerId = checker.id;
    const { endpointSetting, apiKeySetting, usernameSetting } = checker;
    const endpoint = setting(endpointSetting);
    if (!endpoint) {
      // Say what is missing rather than reporting a network failure the user
      // would have to interpret.
      rows = {
        ...rows,
        [checkerId]: {
          state: 'failed',
          detail: tUi('plugins.textCheckers.noEndpoint')
        }
      };
      return;
    }

    rows = { ...rows, [checkerId]: { state: 'checking', detail: null } };
    try {
      const result = await textCheckerTestConnection({
        endpoint,
        apiKey: apiKeySetting ? setting(apiKeySetting) : undefined,
        username: usernameSetting ? setting(usernameSetting) : undefined,
        wantedLanguages: selectedLanguageTags(),
        protocol: checker.protocol
      });
      // A reachable server that lacks the language you write in is the
      // common self-hosted case, and looks identical to "checking does
      // nothing" unless it is said out loud.
      const missing =
        result.ok && result.missingLanguages.length > 0
          ? `${tUi('plugins.textCheckers.missingLanguages')} ${result.missingLanguages.join(', ')}`
          : null;
      rows = {
        ...rows,
        [checkerId]: {
          state: result.ok ? 'ok' : 'failed',
          detail: missing ? `${result.detail} · ${missing}` : result.detail
        }
      };
    } catch (err) {
      rows = {
        ...rows,
        [checkerId]: { state: 'failed', detail: String(err) }
      };
    }
  }
</script>

{#if checkers.length > 0}
  <div class="mt-5">
    <h3
      class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {tUi('plugins.textCheckers.title')}
    </h3>
    <div class="divide-y divide-border">
      {#each checkers as checker (checker.id)}
        {@const row = rows[checker.id]}
        {@const label = resolvePluginStringOptional(pluginId, checker.labelKey)}
        {@const endpoint = setting(checker.endpointSetting)}
        {@const providerId = checkerProviderId(pluginId, checker.id)}
        {@const live = checkerStatus(providerId)}
        {@const ownsSpelling = spellingOwner()?.id === providerId}
        <div class="flex items-start justify-between gap-3 py-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium">
              <Globe class="size-4 shrink-0 text-muted-foreground" />
              <span>{label ?? checker.id}</span>
            </div>
            <!--
              Live state from the checking pipeline, not from the button
              below. A checker that contributes nothing looks exactly like
              a document with nothing wrong in it, so its real state has to
              be visible without the user going looking for it.
            -->
            <p class="mt-0.5 flex items-center gap-1 text-xs">
              {#if live.state === 'active'}
                <CheckCircle2
                  class="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                />
                <span class="text-emerald-600 dark:text-emerald-400">
                  {tUi('plugins.textCheckers.state.active')}
                </span>
              {:else if live.state === 'failed'}
                <XCircle class="size-3.5 shrink-0 text-destructive" />
                <span class="text-destructive">
                  {tUi('plugins.textCheckers.state.failed')}
                </span>
              {:else if live.state === 'unconfigured'}
                <CircleDashed class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="text-muted-foreground">
                  {tUi('plugins.textCheckers.state.unconfigured')}
                </span>
              {:else}
                <CircleDashed class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="text-muted-foreground">
                  {tUi('plugins.textCheckers.state.idle')}
                </span>
              {/if}
              {#if ownsSpelling}
                <span class="text-muted-foreground">
                  · {tUi('plugins.textCheckers.ownsSpelling')}
                </span>
              {/if}
            </p>
            {#if live.detail && live.state === 'failed'}
              <p class="mt-0.5 break-all text-[11px] text-muted-foreground">
                {live.detail}
              </p>
            {/if}
            {#if endpoint}
              <p
                class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground"
              >
                {endpoint}
              </p>
            {:else}
              <p class="mt-0.5 text-xs text-muted-foreground">
                {tUi('plugins.textCheckers.noEndpoint')}
              </p>
            {/if}
            {#if row?.state === 'ok'}
              <p
                class="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 class="size-3.5 shrink-0" />
                {tUi('plugins.textCheckers.reachable')}
              </p>
              {#if row.detail}
                <p class="mt-0.5 text-[11px] text-muted-foreground">
                  {row.detail}
                </p>
              {/if}
            {:else if row?.state === 'failed'}
              <p class="mt-1 flex items-center gap-1 text-xs text-destructive">
                <XCircle class="size-3.5 shrink-0" />
                {tUi('plugins.textCheckers.unreachable')}
              </p>
              {#if row.detail}
                <p class="mt-0.5 break-all text-[11px] text-muted-foreground">
                  {row.detail}
                </p>
              {/if}
            {/if}
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            disabled={row?.state === 'checking'}
            onclick={() => check(checker)}
          >
            <RefreshCw
              class="size-3 {row?.state === 'checking' ? 'animate-spin' : ''}"
            />
            {tUi('plugins.textCheckers.check')}
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}
