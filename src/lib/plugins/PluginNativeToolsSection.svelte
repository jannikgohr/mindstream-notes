<script lang="ts">
  /**
   * Host-owned settings section that lets the user verify a plugin's declared
   * native tools are installed. Rendered inside a plugin's own settings pane (it
   * knows the active plugin id) whenever that plugin declares
   * `contributes.nativeTools`. Each tool gets a Check button that resolves the
   * binary from PATH via `plugins_native_tool_status` and reports availability +
   * the resolved path. Native tools are desktop-only; on mobile the status comes
   * back unavailable.
   */
  import { CheckCircle2, RefreshCw, Terminal, XCircle } from '@lucide/svelte';
  import { pluginsNativeToolStatus } from '$lib/api/plugins';
  import { pluginById } from '$lib/plugins/registry.svelte';
  import { resolvePluginStringOptional } from '$lib/plugins/plugin-i18n';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    pluginId: string;
  }
  let { pluginId }: Props = $props();

  const tools = $derived(
    pluginById(pluginId)?.manifest.contributes.nativeTools ?? []
  );

  type RowState = 'idle' | 'checking' | 'available' | 'missing';
  interface Row {
    state: RowState;
    path: string | null;
  }
  let rows = $state<Record<string, Row>>({});

  async function check(toolId: string) {
    rows = { ...rows, [toolId]: { state: 'checking', path: null } };
    try {
      const status = await pluginsNativeToolStatus(pluginId, toolId);
      rows = {
        ...rows,
        [toolId]: {
          state: status.available ? 'available' : 'missing',
          path: status.path
        }
      };
    } catch {
      rows = { ...rows, [toolId]: { state: 'missing', path: null } };
    }
  }
</script>

{#if tools.length > 0}
  <div class="mt-5">
    <h3
      class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {tUi('plugins.nativeTools.title')}
    </h3>
    <div class="divide-y divide-border">
      {#each tools as tool (tool.id)}
        {@const row = rows[tool.id]}
        {@const description = resolvePluginStringOptional(
          pluginId,
          tool.descriptionKey
        )}
        <div class="flex items-start justify-between gap-3 py-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium">
              <Terminal class="size-4 shrink-0 text-muted-foreground" />
              <code class="font-mono">{tool.binaryName}</code>
            </div>
            {#if description}
              <p class="mt-0.5 text-xs text-muted-foreground">{description}</p>
            {/if}
            {#if row?.state === 'available'}
              <p
                class="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 class="size-3.5 shrink-0" />
                {tUi('plugins.nativeTools.available')}
              </p>
              {#if row.path}
                <p
                  class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground"
                >
                  {row.path}
                </p>
              {/if}
            {:else if row?.state === 'missing'}
              <p class="mt-1 flex items-center gap-1 text-xs text-destructive">
                <XCircle class="size-3.5 shrink-0" />
                {tUi('plugins.nativeTools.notFound')}
              </p>
            {/if}
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            disabled={row?.state === 'checking'}
            onclick={() => check(tool.id)}
          >
            <RefreshCw
              class="size-3 {row?.state === 'checking' ? 'animate-spin' : ''}"
            />
            {tUi('plugins.nativeTools.check')}
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}
