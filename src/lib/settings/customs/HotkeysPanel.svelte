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
    HotkeyBindingConflictError,
    HOTKEY_COMMANDS,
    isGlobalShortcutCommand,
    isCustomized,
    isMac,
    parseBinding,
    resetBinding,
    setBinding,
    wellKnownConflict,
    type CommandGroup,
    type CommandDefinition
  } from '$lib/hotkeys';
  import { confirm } from '$lib/components/confirm-dialog.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';

  interface Props {
    searchQuery?: string;
  }
  let { searchQuery = '' }: Props = $props();

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
  /** Reason string from `wellKnownConflict()` if the pending binding
   *  hits a chord the OS captures (Cmd+Q, Alt+Tab, …). Advisory only —
   *  the user can still save it. */
  let osConflictReason = $state<string | null>(null);
  let feedback = $state<{
    kind: 'success' | 'error' | 'warning';
    commandId: string | null;
    message: string;
  } | null>(null);

  /**
   * On macOS, the Option (Alt) key composes characters: Alt+A becomes
   * `å`, Alt+1 becomes `¡`, etc. Holding Cmd ALSO suppresses that
   * composition, so `mod+alt+letter` records cleanly. But `alt+letter`
   * by itself captures the typed special character — the resulting
   * binding looks weird to the user ("alt+å" — what's that?) even
   * though it functions.
   *
   * Show a one-line hint when the pending binding is in that shape.
   * The hint is advisory, not blocking: a user who actually wants
   * `alt+å` (a real character on their layout) can still save it.
   *
   * Derived rather than computed inline so the template stays
   * readable; `pendingBinding` is the only dynamic input so the
   * derivation cost is negligible.
   */
  const showMacAltHint = $derived.by(() => {
    if (!pendingBinding) return false;
    if (!isMac()) return false;
    const chord = parseBinding(pendingBinding);
    if (!chord) return false;
    return chord.alt && !chord.mod;
  });

  /** Static catalogue grouped by scope/editor-kind. The catalogue
   *  itself doesn't change at runtime, and per-binding reactivity
   *  comes from `getBinding(cmd.id)` inside the row template
   *  (`hotkeys.bindings[id]` is per-key tracked) — so this is a plain
   *  one-shot read, not a `$derived`. */
  const catalogueGroups = groupedCommands();
  const globalShortcutsEnabled = $derived(
    getSettingValue('hotkeys.globalShortcuts') === true
  );
  const lowerSearchQuery = $derived(searchQuery.trim().toLowerCase());

  type DisplayCommandGroup = CommandGroup & {
    displayScope?: 'globalShortcuts';
  };

  const groups = $derived.by<DisplayCommandGroup[]>(() => {
    if (!globalShortcutsEnabled) return catalogueGroups;

    const next: DisplayCommandGroup[] = [];
    for (const group of catalogueGroups) {
      if (group.scope !== 'global') {
        next.push(group);
        continue;
      }

      const globalShortcutCommands = group.commands.filter(
        isGlobalShortcutCommand
      );
      const applicationCommands = group.commands.filter(
        (cmd) => !isGlobalShortcutCommand(cmd)
      );

      if (globalShortcutCommands.length > 0) {
        next.push({
          scope: 'global',
          editorKind: null,
          commands: globalShortcutCommands,
          displayScope: 'globalShortcuts'
        });
      }
      if (applicationCommands.length > 0) {
        next.push({ ...group, commands: applicationCommands });
      }
    }
    return next;
  });

  /**
   * Does any command differ from its catalogue default? Drives the
   * "Reset all" button's disabled state. Reactive via `isCustomized`,
   * which reads through `getBinding` → `hotkeys.bindings[id]`, so the
   * button enables / disables live as the user customises and resets
   * individual rows.
   */
  const anyCustomized = $derived(
    HOTKEY_COMMANDS.some((c) => isCustomized(c.id))
  );

  /** Flat lookup so the conflict warning can render the OTHER
   *  command's label without re-walking the groups array. */
  const flatById = new Map<string, CommandDefinition>(
    HOTKEY_COMMANDS.map((c) => [c.id, c])
  );

  function groupLabel(group: DisplayCommandGroup): string {
    if (group.displayScope === 'globalShortcuts') {
      return tUi('hotkeys.group.globalShortcuts');
    }
    const { scope, editorKind } = group;
    if (scope === 'global') return tUi('hotkeys.group.global');
    return tUi(`hotkeys.group.editor.${editorKind}`);
  }

  function commandLabel(cmd: CommandDefinition): string {
    return tUi(cmd.labelKey);
  }

  function commandMatchesSearch(
    cmd: CommandDefinition,
    current: string | null,
    groupName: string
  ): boolean {
    if (!lowerSearchQuery) return true;
    const display = displayBinding(current) || tUi('hotkeys.unset');
    return [cmd.id, commandLabel(cmd), groupName, current ?? '', display]
      .join(' ')
      .toLowerCase()
      .includes(lowerSearchQuery);
  }

  function conflictLabel(id: string): string {
    const cmd = flatById.get(id);
    return cmd ? commandLabel(cmd) : id;
  }

  function feedbackText(
    key: string,
    replacements: Record<string, string> = {}
  ) {
    let text = tUi(key);
    for (const [name, value] of Object.entries(replacements)) {
      text = text.replace(`{${name}}`, value);
    }
    return text;
  }

  function feedbackClass(kind: 'success' | 'error' | 'warning'): string {
    if (kind === 'error') {
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    }
    if (kind === 'warning') {
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400';
    }
    return 'border-border bg-muted text-muted-foreground';
  }

  function errorMessage(err: unknown): string {
    if (err instanceof Error && err.message.trim()) return err.message;
    if (typeof err === 'string' && err.trim()) return err;
    return feedbackText('hotkeys.feedback.unknownError');
  }

  function isModifierOnlyEvent(e: KeyboardEvent): boolean {
    return (
      e.key === 'Shift' ||
      e.key === 'Control' ||
      e.key === 'Alt' ||
      e.key === 'Meta' ||
      e.key === 'Dead' ||
      e.isComposing
    );
  }

  function startRecording(cmd: CommandDefinition) {
    recordingId = cmd.id;
    pendingBinding = null;
    conflictWithId = null;
    osConflictReason = null;
    feedback = null;
  }

  function cancelRecording() {
    recordingId = null;
    pendingBinding = null;
    conflictWithId = null;
    osConflictReason = null;
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
      if (!isModifierOnlyEvent(e)) {
        feedback = {
          kind: 'error',
          commandId: recordingId,
          message: feedbackText('hotkeys.feedback.invalid')
        };
      }
      return;
    }
    pendingBinding = binding;
    feedback = null;

    const owner = findCommandByBinding(binding, recordingId ?? undefined);
    conflictWithId = owner && owner.id !== recordingId ? owner.id : null;
    osConflictReason = wellKnownConflict(binding);
    if (conflictWithId) {
      feedback = {
        kind: 'error',
        commandId: recordingId,
        message: feedbackText('hotkeys.feedback.conflict', {
          command: conflictLabel(conflictWithId)
        })
      };
    }
  }

  async function commitRecording() {
    if (!recordingId || !pendingBinding) return;
    const commandId = recordingId;
    const binding = pendingBinding;
    if (conflictWithId) {
      feedback = {
        kind: 'error',
        commandId,
        message: feedbackText('hotkeys.feedback.conflict', {
          command: conflictLabel(conflictWithId)
        })
      };
      return;
    }
    try {
      await setBinding(commandId, binding);
      if (osConflictReason) {
        feedback = {
          kind: 'warning',
          commandId,
          message: feedbackText('hotkeys.feedback.savedWithOsWarning')
        };
      } else {
        feedback = {
          kind: 'success',
          commandId,
          message: feedbackText('hotkeys.feedback.saved')
        };
      }
      cancelRecording();
    } catch (err) {
      console.error('[HotkeysPanel] commit failed', err);
      if (err instanceof HotkeyBindingConflictError) {
        conflictWithId = err.conflictingCommandId;
        feedback = {
          kind: 'error',
          commandId,
          message: feedbackText('hotkeys.feedback.conflict', {
            command: conflictLabel(err.conflictingCommandId)
          })
        };
        return;
      }
      feedback = {
        kind: 'error',
        commandId,
        message: feedbackText('hotkeys.feedback.saveFailed', {
          reason: errorMessage(err)
        })
      };
    }
  }

  async function unset(cmd: CommandDefinition) {
    try {
      await setBinding(cmd.id, null);
      feedback = {
        kind: 'success',
        commandId: cmd.id,
        message: feedbackText('hotkeys.feedback.cleared', {
          command: commandLabel(cmd)
        })
      };
    } catch (err) {
      console.error('[HotkeysPanel] unset failed', err);
      feedback = {
        kind: 'error',
        commandId: cmd.id,
        message: feedbackText('hotkeys.feedback.saveFailed', {
          reason: errorMessage(err)
        })
      };
    }
  }

  async function reset(cmd: CommandDefinition) {
    try {
      await resetBinding(cmd.id);
      feedback = {
        kind: 'success',
        commandId: cmd.id,
        message: feedbackText('hotkeys.feedback.reset', {
          command: commandLabel(cmd)
        })
      };
    } catch (err) {
      console.error('[HotkeysPanel] reset failed', err);
      feedback = {
        kind: 'error',
        commandId: cmd.id,
        message: feedbackText('hotkeys.feedback.saveFailed', {
          reason: errorMessage(err)
        })
      };
    }
  }

  /**
   * Restore every command's binding to the catalogue default.
   *
   * Gated behind a confirm — this wipes the user's customisations in
   * one click and there's no undo (each reset persists immediately).
   * The `destructive` variant on the dialog tints the confirm button
   * red so the action's weight is obvious.
   *
   * Iterates `HOTKEY_COMMANDS` rather than `Object.keys(hotkeys.bindings)`
   * so commands the user has never touched (no entry in the map) still
   * get an explicit re-write back to default — a no-op for them, but
   * keeps the post-reset state describable as "every row matches the
   * catalogue" instead of "every row the user touched matches".
   */
  async function resetAll() {
    const ok = await confirm({
      title: tUi('hotkeys.resetAll.title'),
      message: tUi('hotkeys.resetAll.message'),
      confirmLabel: tUi('hotkeys.resetAll.confirm'),
      destructive: true
    });
    if (!ok) return;
    // Sequential rather than Promise.all so a write that fails can
    // stop on the exact command that needs feedback. Catalogue is
    // small (~17 entries) — the cost is invisible.
    for (const cmd of HOTKEY_COMMANDS) {
      try {
        await resetBinding(cmd.id);
      } catch (err) {
        console.error('[HotkeysPanel] reset failed for', cmd.id, err);
        feedback = {
          kind: 'error',
          commandId: cmd.id,
          message: feedbackText('hotkeys.feedback.saveFailed', {
            reason: errorMessage(err)
          })
        };
        return;
      }
    }
    feedback = {
      kind: 'success',
      commandId: null,
      message: feedbackText('hotkeys.feedback.resetAll')
    };
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

<!--
  Reset-all anchor: top-right of the panel so the destructive action
  sits away from the per-row controls. Disabled when nothing is
  customised so the button doesn't tempt users to click a no-op.
-->
<div class="mt-2 flex justify-end">
  <Button
    variant="ghost"
    size="sm"
    onclick={resetAll}
    disabled={!anyCustomized}
    title={tUi('hotkeys.resetAll.tooltip')}
  >
    <RotateCcw class="size-3.5" />
    {tUi('hotkeys.resetAll.label')}
  </Button>
</div>

<div class="mt-2 space-y-6">
  {#each groups as group (`${group.displayScope ?? group.scope}:${group.editorKind ?? ''}`)}
    {@const title = groupLabel(group)}
    {@const visibleCommands = group.commands.filter((cmd) =>
      commandMatchesSearch(cmd, getBinding(cmd.id), title)
    )}
    {#if visibleCommands.length > 0}
      <div>
        <h4
          class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {title}
        </h4>
        <div class="divide-y divide-border">
          {#each visibleCommands as cmd (cmd.id)}
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
              <div class="flex flex-col items-end gap-1.5">
                {#if recording && conflictWithId}
                  <div
                    role="status"
                    aria-live="polite"
                    class="max-w-[28rem] rounded-md border px-3 py-2 text-xs {feedbackClass(
                      'error'
                    )}"
                  >
                    {feedbackText('hotkeys.feedback.conflict', {
                      command: conflictLabel(conflictWithId)
                    })}
                  </div>
                {:else if recording && feedback && feedback.commandId === cmd.id}
                  <div
                    role="status"
                    aria-live="polite"
                    class="max-w-[28rem] rounded-md border px-3 py-2 text-xs {feedbackClass(
                      feedback.kind
                    )}"
                  >
                    {feedback.message}
                  </div>
                {/if}
                <div class="flex items-center gap-1.5">
                  {#if recording}
                    {@const originalDisplay = display || tUi('hotkeys.unset')}
                    <button
                      type="button"
                      data-hotkey-recorder="true"
                      class="flex h-7 min-w-[10rem] items-center justify-center gap-1 rounded-md border border-ring bg-accent px-2 font-mono text-xs text-accent-foreground"
                      onkeydown={onRecordKeyDown}
                      onclick={(e) => e.preventDefault()}
                      use:focusOnMount
                      aria-label={tUi('hotkeys.recording.prompt')}
                    >
                      {#if pendingBinding}
                        {displayBinding(pendingBinding)}
                      {:else}
                        <!--
                        Show the existing binding next to the "Press a
                        key…" prompt so the user keeps a visual anchor of
                        what they're about to replace. Disappears the
                        moment they press a key — at that point what
                        matters is the NEW chord, not the old one.
                      -->
                        <span class="text-muted-foreground"
                          >{originalDisplay}</span
                        >
                        <span class="text-muted-foreground" aria-hidden="true"
                          >→</span
                        >
                        <span>{tUi('hotkeys.recording.prompt')}</span>
                      {/if}
                    </button>
                    {#if pendingBinding && osConflictReason}
                      <!--
                      OS-collision warning. Uses an amber muted-foreground
                      rather than destructive red because the user may
                      still want to save the binding — many "OS reserved"
                      chords are actually overridable in a Tauri webview;
                      we just can't tell for sure.
                    -->
                      <span
                        class="max-w-[16rem] text-xs text-amber-600 dark:text-amber-500"
                        title={tUi('hotkeys.osConflict.tooltip')}
                      >
                        {tUi('hotkeys.osConflict.label')}: {osConflictReason}
                      </span>
                    {/if}
                    {#if showMacAltHint}
                      <!--
                      Plain muted-foreground because this is informational,
                      not a warning — the binding works as recorded, just
                      looks unfamiliar. Suggesting Cmd is the easiest
                      fix; we don't try to force it.
                    -->
                      <span
                        class="max-w-[18rem] text-xs text-muted-foreground"
                        title={tUi('hotkeys.macAltHint.tooltip')}
                      >
                        {tUi('hotkeys.macAltHint.label')}
                      </span>
                    {/if}
                    {#if pendingBinding}
                      <Button
                        size="sm"
                        variant="default"
                        disabled={Boolean(conflictWithId)}
                        title={conflictWithId
                          ? tUi('hotkeys.conflict.tooltip')
                          : undefined}
                        onclick={commitRecording}
                      >
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
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/each}
  {#if lowerSearchQuery && groups.every((group) => {
      const title = groupLabel(group);
      return group.commands.every((cmd) => !commandMatchesSearch(cmd, getBinding(cmd.id), title));
    })}
    <p class="py-6 text-center text-sm text-muted-foreground">
      {tUi('hotkeys.search.empty')}
    </p>
  {/if}
</div>
