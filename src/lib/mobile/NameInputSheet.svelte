<script lang="ts">
  /**
   * Bottom-sheet name input used by the mobile shell for note + folder
   * creation and renaming. Replaces window.prompt — that one renders as
   * a desktop alert with no theming, no keyboard awareness, and no
   * affordance for the surrounding sheet.
   *
   * Behaviour:
   *   - Auto-focuses the input on mount; if it has an initial value it's
   *     pre-selected so the user can replace it in one keystroke.
   *   - Enter submits; Escape closes. Save is disabled until the trimmed
   *     value is non-empty.
   *   - Backdrop tap or the X button closes the sheet without saving.
   *   - safe-bottom + safe-x padding so the sheet doesn't paint under
   *     the Android gesture bar with edge-to-edge enabled.
   */
  import { onMount, untrack } from 'svelte';
  import { X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  interface Props {
    /** Header label shown above the input. */
    title: string;
    /** Input placeholder. Defaults to the title. */
    placeholder?: string;
    /** Pre-filled value. Empty = create flow; non-empty = rename flow. */
    initialValue?: string;
    /** Confirm-button label. */
    submitLabel?: string;
    onSubmit: (name: string) => void;
    onClose: () => void;
  }
  let {
    title,
    placeholder,
    initialValue = '',
    submitLabel = 'Save',
    onSubmit,
    onClose
  }: Props = $props();

  // Snapshot the initial value once at construction time so the onMount
  // focus/select call doesn't fight a later prop update. untrack() is
  // needed because $props() reads are otherwise reactive — without it
  // Svelte flags this as a stale capture.
  const startingValue = untrack(() => initialValue);
  let value = $state(startingValue);
  let inputEl: HTMLInputElement | null = $state(null);

  const trimmed = $derived(value.trim());
  const canSubmit = $derived(trimmed.length > 0);

  onMount(() => {
    // Focus inside a microtask so the sheet's mount animation doesn't
    // race the focus call and re-scroll the page on Android.
    queueMicrotask(() => {
      if (!inputEl) return;
      inputEl.focus();
      if (startingValue) inputEl.select();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function submit() {
    if (!canSubmit) return;
    onSubmit(trimmed);
    onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

<button
  type="button"
  aria-label="Cancel"
  class="fixed inset-0 z-40 bg-black/40"
  onclick={onClose}
></button>

<div
  class="safe-bottom safe-x fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-xl border border-border bg-card shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label={title}
>
  <header
    class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3"
  >
    <span class="text-sm font-semibold">{title}</span>
    <Button
      variant="ghost"
      size="icon"
      onclick={onClose}
      title="Cancel"
      aria-label="Cancel"
    >
      <X class="size-5" />
    </Button>
  </header>

  <div class="flex flex-col gap-3 px-4 py-4">
    <Input
      bind:ref={inputEl}
      bind:value
      placeholder={placeholder ?? title}
      onkeydown={onKeydown}
      autocomplete="off"
      spellcheck="false"
      class="h-11 text-base"
    />

    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button onclick={submit} disabled={!canSubmit}>{submitLabel}</Button>
    </div>
  </div>
</div>
