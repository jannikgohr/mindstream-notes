<script lang="ts">
  import { lineDiff, diffStats, type DiffOp } from '$lib/diff/line-diff';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    /** Source text for the comparison. */
    fromText: string;
    /** Target text for the comparison. */
    toText: string;
  }
  let { fromText, toText }: Props = $props();

  const ops = $derived<DiffOp[]>(lineDiff(fromText, toText));
  const stats = $derived(diffStats(ops));

  function symbol(type: DiffOp['type']): string {
    return type === 'add' ? '+' : type === 'del' ? '−' : ' ';
  }
</script>

<div class="text-xs">
  <p class="mb-2 text-[11px] text-muted-foreground">
    <span class="text-emerald-600 dark:text-emerald-400"
      >+{stats.added} {tUi('history.diff.added')}</span
    >
    ·
    <span class="text-rose-600 dark:text-rose-400"
      >−{stats.removed} {tUi('history.diff.removed')}</span
    >
  </p>
  {#if ops.length === 0}
    <p class="text-muted-foreground">{tUi('history.diff.identical')}</p>
  {:else}
    <pre
      class="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{#each ops as op (op)}<div
          class={op.type === 'add'
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : op.type === 'del'
              ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
              : 'text-foreground/80'}><span
            class="mr-1.5 select-none opacity-60">{symbol(op.type)}</span
          >{op.text || ' '}</div>{/each}</pre>
  {/if}
</div>
