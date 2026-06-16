<script lang="ts">
  import { Check, ChevronDown, Minus, Plus } from 'lucide-svelte';
  import { cn } from '$lib/utils';
  import ToolbarButton from './toolbar-button.svelte';

  type Props = {
    label: string;
    zoomOutLabel: string;
    zoomInLabel: string;
    zoomMenuLabel: string;
    fitLabel?: string;
    fitActive?: boolean;
    zoomOptions?: number[];
    selectedZoom?: number | null;
    open?: boolean;
    disabled?: boolean;
    menuPlacement?: 'above' | 'below';
    class?: string;
    onZoomOut: () => void;
    onZoomIn: () => void;
    onFit?: () => void;
    onSelectZoom?: (zoom: number) => void;
  };

  let {
    label,
    zoomOutLabel,
    zoomInLabel,
    zoomMenuLabel,
    fitLabel,
    fitActive = false,
    zoomOptions = [],
    selectedZoom = null,
    open = $bindable(false),
    disabled = false,
    menuPlacement = 'below',
    class: className,
    onZoomOut,
    onZoomIn,
    onFit,
    onSelectZoom
  }: Props = $props();

  let trigger = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let rectVersion = $state(0);

  const menuRect = $derived.by(() => {
    void rectVersion;
    return trigger?.getBoundingClientRect() ?? null;
  });
  const menuLeft = $derived.by(() => {
    if (!menuRect || typeof window === 'undefined') return 0;
    const width = 160;
    return Math.max(8, Math.min(menuRect.left, window.innerWidth - width - 8));
  });
  const menuStyle = $derived.by(() => {
    if (!menuRect) return '';
    const top = menuPlacement === 'above' ? menuRect.top : menuRect.bottom;
    const transform =
      menuPlacement === 'above' ? 'transform: translateY(-100%);' : '';
    return `left: ${menuLeft}px; top: ${top}px; ${transform}`;
  });
  const hasMenu = $derived(Boolean(onFit || zoomOptions.length > 0));

  function toggleMenu() {
    if (!hasMenu || disabled) return;
    open = !open;
    rectVersion += 1;
  }

  function selectFit() {
    onFit?.();
    open = false;
  }

  function selectZoom(value: number) {
    onSelectZoom?.(value);
    open = false;
  }

  $effect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuEl?.contains(target)) return;
      if (trigger?.contains(target)) return;
      open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    const onResize = () => {
      rectVersion += 1;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });
</script>

<div class={cn('flex items-center gap-0.5', className)}>
  <ToolbarButton
    onclick={onZoomOut}
    aria-label={zoomOutLabel}
    title={zoomOutLabel}
    {disabled}
  >
    <Minus aria-hidden="true" />
  </ToolbarButton>

  <ToolbarButton
    bind:ref={trigger}
    wide
    class="min-w-22 justify-center font-medium text-muted-foreground"
    onclick={toggleMenu}
    aria-label={zoomMenuLabel}
    aria-haspopup={hasMenu ? 'menu' : undefined}
    aria-expanded={hasMenu ? open : undefined}
    title={zoomMenuLabel}
    {disabled}
  >
    <span>{label}</span>
    <ChevronDown aria-hidden="true" />
  </ToolbarButton>

  <ToolbarButton
    onclick={onZoomIn}
    aria-label={zoomInLabel}
    title={zoomInLabel}
    {disabled}
  >
    <Plus aria-hidden="true" />
  </ToolbarButton>
</div>

{#if open && hasMenu && menuRect}
  <div
    bind:this={menuEl}
    role="menu"
    class="fixed z-50 min-w-40 rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
    style={menuStyle}
  >
    {#if onFit && fitLabel}
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
        onclick={selectFit}
      >
        <Check
          class="size-4 shrink-0 {fitActive ? 'opacity-100' : 'opacity-0'}"
          aria-hidden="true"
        />
        <span>{fitLabel}</span>
      </button>
    {/if}

    {#if onFit && fitLabel && zoomOptions.length > 0}
      <div class="my-1 border-t border-border"></div>
    {/if}

    {#each zoomOptions as option (option)}
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
        onclick={() => selectZoom(option)}
      >
        <Check
          class="size-4 shrink-0 {selectedZoom !== null &&
          Math.abs(selectedZoom - option) < 0.01
            ? 'opacity-100'
            : 'opacity-0'}"
          aria-hidden="true"
        />
        <span>{Math.round(option * 100)}%</span>
      </button>
    {/each}
  </div>
{/if}
