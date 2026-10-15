<script lang="ts">
  /**
   * A key as digits, in the rows the client library sets them in, so that
   * two people can read it to each other.
   */
  interface Props {
    value: string;
    label?: string;
  }

  let { value, label }: Props = $props();
</script>

<div class="space-y-0.5">
  {#if label}
    <div class="text-[11px] font-medium text-muted-foreground">{label}</div>
  {/if}
  <pre
    class="select-all whitespace-pre rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground"
    data-testid="key-fingerprint">{value}</pre>
</div>
