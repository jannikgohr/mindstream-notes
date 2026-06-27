<script lang="ts">
  /**
   * Rendered-prose diff for the history modal, via `@milkdown/plugin-diff`.
   *
   * We render the OLD snapshot in a read-only Crepe, register the diff plugin,
   * then run `startDiffReviewCmd(currentMarkdown)` so the plugin decorates the
   * document with the changes between old → current (insertions/deletions). We
   * deliberately expose no accept/reject affordances — this is a read-only view.
   *
   * Defensive on purpose: the diff plugin (7.21.x) runs against this app's
   * Milkdown 7.20.x, so if a runtime context mismatch surfaces we catch it and
   * show a fallback message instead of breaking the modal.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { diff, startDiffReviewCmd } from '@milkdown/plugin-diff';
  import { callCommand } from '@milkdown/kit/utils';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    oldMarkdown: string;
    newMarkdown: string;
  }
  let { oldMarkdown, newMarkdown }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let crepe: Crepe | null = null;
  let failed = $state(false);

  onMount(async () => {
    if (!host) return;
    try {
      const instance = new Crepe({ root: host, defaultValue: oldMarkdown });
      // `diff` / the command key are typed against plugin-diff's nested
      // @milkdown/ctx (7.21.x), which is a different type identity than the
      // editor's (7.20.x). Vite's resolve.dedupe collapses them to one runtime
      // instance, so these casts are sound — the nominal type split is the only
      // thing TS sees.
      instance.editor.use(diff as never);
      crepe = instance;
      await instance.create();
      instance.setReadonly(true);
      instance.editor.action(
        callCommand(startDiffReviewCmd.key as never, newMarkdown)
      );
    } catch (err) {
      console.error('[history] diff render failed', err);
      failed = true;
    }
  });

  onDestroy(() => {
    crepe?.destroy();
    crepe = null;
  });
</script>

{#if failed}
  <p class="p-4 text-sm text-muted-foreground">{tUi('history.diffFailed')}</p>
{/if}
<div
  bind:this={host}
  class="milkdown-diff h-full overflow-y-auto"
  class:hidden={failed}
></div>
