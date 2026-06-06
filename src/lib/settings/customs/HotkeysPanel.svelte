<script lang="ts">
  /**
   * The full hotkey configuration UI.
   *
   * Rendered as a single `type: 'custom'` row in the settings dialog
   * (see `schema.json` → category `hotkeys`). One panel covers every
   * scope so the user can scan and rebind without flipping between
   * sub-tabs — the list is short enough (under 20 rows on day one)
   * that a flat layout reads better than nested categories.
   *
   * Three states per row:
   *
   *   - Idle: shows the formatted binding chip. Click to enter
   *     recording mode. A second button next to the chip clears the
   *     binding to "unset" (`null`); a third restores the default.
   *
   *   - Recording: the chip becomes a `tabindex=0` capture surface that
   *     listens to the next keydown. Escape cancels, any other valid
   *     chord commits via `setBinding`.
   *
   *   - Conflict warning: if the typed chord is already bound to
   *     another command, we surface that command's label inline and
   *     let the user save anyway (the store performs the swap).
   *     Negative-space: we DON'T silently overwrite — the user must
   *     confirm.
   */
  import { Pencil, RotateCcw, XCircle } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    bindingFromEvent,
    canonicalize,
    displayBinding,
    findCommandByBinding,
    getBinding,
    groupedCommands,
    isCustomized,
    resetBinding,
    setBinding,
    type CommandDefinition
  } from '$lib/hotkeys';
  import { tUi } from '$lib/settings/i18n.svelte';

  /**
   * Local recording state. Only one row can record at a time — the
   * settings dialog has no use case for two simultaneous recorders, and
   * letting two rows compete for the same keydown would be a guaranteed
   * source of "why does my Mod+B keep flipping the wrong row" bugs.
   */
  let recordingId = $state<string | null>(null);
  let pendingBinding = $state<string | null>(null);
  /** Identifier of the OTHER command the pending binding currently
   *  belongs to, surfaced as the conflict warning. Null when there's
   *  no conflict. */
  let conflictWithId = $state<string | null>(null);

  /** Static catalogue grouped by scope/editor-kind. The catalogue
   *  itself doesn't change at runtime, and per-binding reactivity
   *  comes from `getBinding(cmd.id)` inside the row template
   *  (`hotkeys.bindings[id]` is per-key tracked) — so this is a plain
   *  one-shot read, not a `$derived`. */
  const groups = groupedCommands();

  /** Flat lookup so the conflict warning can render the OTHER
   *  command's label without re-walking the groups array. */
  const flatById = new Map<string, CommandDefinition>(
    groups.flatMap((g) => g.commands.map((c) => [c.id, c]))
  );

  function groupLabel(scope: string, kind: string | null): string {
    if (scope === 'global') return tUi('hotkeys.group.global');
    return tUi(`hotkeys.group.editor.${kind}`);
  }

  function commandLabel(cmd: CommandDefinition): string {
    return tUi(cmd.labelKey);
  }

  function conflictLabel(id: string): string {
    const cmd = flatById.get(id);
    return cmd ? commandLabel(cmd) : id;
  }

  function startRecording(cmd: CommandDefinition) {
    recordingId = cmd.id;
    pendingBinding = null;
    conflictWithId = null;
  }

  function cancelRecording() {
    recordingId = null;
    pendingBinding = null;
    conflictWithId = null;
  }

  /**
   * Keydown handler attached to the recording chip. Stops propagation
   * so the document-level hotkey manager doesn't ALSO act on the same
   * keypress while the user is binding it — without this, recording
   * `Mod+,` would also re-open the settings dialog.
   */
  function onRecordKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    // Escape with no modifiers cancels. Treated specially because
    // Escape is itself a bindable key; using it as the cancel signal
    // would be ambiguous, so we reserve unmodified Escape for cancel.
    if (
      e.key === 'Escape' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      cancelRecording();
      return;
    }

    const binding = bindingFromEvent(e);
    if (!binding) {
      // Modifier-only press, dead key, IME — wait for a real chord.
      // Don't update pendingBinding so the prompt stays visible.
      return;
    }
    pendingBinding = binding;

    const owner = findCommandByBinding(binding);
    conflictWithId = owner && owner.id !== recordingId ? owner.id : null;
  }

  async function commitRecording() {
    if (!recordingId || !pendingBinding) return;
    try {
      await setBinding(recordingId, pendingBinding);
    } catch (err) {
      console.error('[HotkeysPanel] commit failed', err);
    }
    cancelRecording();
  }

  async function unset(cmd: CommandDefinition) {
    try {
      await setBinding(cmd.id, null);
    } catch (err) {
      console.error('[HotkeysPanel] unset failed', err);
    }
  }

  async function reset(cmd: CommandDefinition) {
    try {
      await resetBinding(cmd.id);
    } catch (err) {
      console.error('[HotkeysPanel] reset failed', err);
    }
  }

  /**
   * Svelte action: focus the capture chip the moment it mounts so the
   * user's next keystroke is the binding without an extra Tab. The
   * microtask defer avoids racing with the dialog's scroll restoration
   * — focusing on the same tick can scroll the row out of view on
   * some browsers.
   */
  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus());
    return {};
  }
</script>

<div class="mt-2 space-y-6">
  {#each groups as group (`${group.scope}:${group.editorKind ?? ''}`)}
    <div>
      <h4
        class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {groupLabel(group.scope, group.editorKind)}
      </h4>
      <div class="divide-y divide-border">
        {#each group.commands as cmd (cmd.id)}
          {@const recording = recordingId === cmd.id}
          {@const current = getBinding(cmd.id)}
          {@const display = displayBinding(current)}
          {@const customized = isCustomized(cmd.id)}
          {@const defaultBindingCanonical = canonicalize(cmd.defaultBinding)}
          {@const currentCanonical = canonicalize(current)}
          <div
            class="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-2.5"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm">{commandLabel(cmd)}</span>
              {#if customized}
                <span
                  class="inline-block size-1.5 rounded-full bg-primary"
                  title={tUi('modified')}
                  aria-label={tUi('modified')}
                ></span>
              {/if}
            </div>
            <div class="flex items-center gap-1.5">
              {#if recording}
                <button
                  type="button"
                  class="flex h-7 min-w-[7rem] items-center justify-center rounded-md border border-ring bg-accent px-2 font-mono text-xs text-accent-foreground"
                  onkeydown={onRecordKeyDown}
                  onclick={(e) => e.preventDefault()}
                  use:focusOnMount
                  aria-label={tUi('hotkeys.recording.prompt')}
                >
                  {pendingBinding
                    ? displayBinding(pendingBinding)
                    : tUi('hotkeys.recording.prompt')}
                </button>
                {#if pendingBinding && conflictWithId}
                  <span
                    class="max-w-[14rem] text-xs text-destructive"
                    title={tUi('hotkeys.conflict.tooltip')}
                  >
                    {tUi('hotkeys.conflict.label')}: {conflictLabel(
                      conflictWithId
                    )}
                  </span>
                {/if}
                {#if pendingBinding}
                  <Button size="sm" variant="default" onclick={commitRecording}>
                    {tUi('hotkeys.recording.save')}
                  </Button>
                {/if}
                <Button size="sm" variant="ghost" onclick={cancelRecording}>
                  {tUi('hotkeys.recording.cancel')}
                </Button>
              {:else}
                <button
                  type="button"
                  class="flex h-7 min-w-[7rem] items-center justify-center rounded-md border border-input bg-background px-2 font-mono text-xs transition-colors hover:border-ring hover:bg-accent"
                  onclick={() => startRecording(cmd)}
                  title={tUi('hotkeys.editChip.tooltip')}
                  aria-label={tUi('hotkeys.editChip.aria')}
                >
                  {#if display}
                    {display}
                  {:else}
                    <span class="text-muted-foreground"
                      >{tUi('hotkeys.unset')}</span
                    >
                  {/if}
                </button>
                <button
                  type="button"
                  class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onclick={() => startRecording(cmd)}
                  title={tUi('hotkeys.edit')}
                  aria-label={tUi('hotkeys.edit')}
                >
                  <Pencil class="size-3.5" />
                </button>
                {#if current !== null}
                  <button
                    type="button"
                    class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onclick={() => unset(cmd)}
                    title={tUi('hotkeys.unsetAction')}
                    aria-label={tUi('hotkeys.unsetAction')}
                  >
                    <XCircle class="size-3.5" />
                  </button>
                {/if}
                {#if customized && defaultBindingCanonical !== currentCanonical}
                  <button
                    type="button"
                    class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onclick={() => reset(cmd)}
                    title={tUi('reset')}
                    aria-label={tUi('reset')}
                  >
                    <RotateCcw class="size-3.5" />
                  </button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
