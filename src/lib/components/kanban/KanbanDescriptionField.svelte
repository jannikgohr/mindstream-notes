<!--
  The card editor's description box, with the app's own spellchecking.

  Replaces SVAR's `textarea` editor item. A textarea cannot carry a squiggle:
  the only underline it can show is the webview's native one, which is the
  checker this app deliberately replaced — it differs per platform, its
  dictionaries are not selectable from inside the app, and its suggestion menu
  is unreachable in PROD builds anyway, because the root layout suppresses the
  native context menu. So a card description was the one place left where the
  user could type prose and get either nothing or a second, worse checker.

  Rather than build a highlight overlay behind a transparent textarea — a
  mirror div that has to track the textarea's font, padding, wrapping and
  scroll offset exactly, and that drifts the moment any of those change — this
  reuses the surface that already draws diagnostics correctly. CodeMirror with
  the `sourceDiagnostics` extension gives the same squiggles, the same popover,
  the same personal dictionary and the same "add to dictionary" as the note
  editors, for the cost of a theme that makes it look like the textarea it
  replaced.

  The syntax is `plain`: a card description is prose, and a `#` in it is a
  hash. See `$lib/diagnostics/syntax`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, StateEffect, type Extension } from '@codemirror/state';
  import { EditorView, keymap, placeholder } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { sourceDiagnostics } from '$lib/editor/plugins';
  import { plainSyntax } from '$lib/diagnostics/syntax';
  import {
    checkSegments,
    spellcheckEnabled,
    subscribeDiagnosticsInvalidated,
    suggestFor
  } from '$lib/diagnostics/editor-diagnostics.svelte';
  import {
    closeDiagnosticPopover,
    diagnosticAnchorFrom,
    openDiagnosticPopover,
    type DiagnosticMenuContext
  } from '$lib/diagnostics/popover-bridge.svelte';
  import type { Diagnostic } from '$lib/diagnostics/types';

  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    error?: boolean;
    /**
     * SVAR's editor-item contract: `input: true` for a keystroke, absent for a
     * commit. The card editor debounces the first and saves on the second, so
     * both have to keep firing exactly as the textarea fired them.
     */
    onchange?: (ev: { value: string; input?: boolean }) => void;
  }

  let {
    value = '',
    placeholder: placeholderText = '',
    disabled = false,
    readonly = false,
    error = false,
    onchange
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;

  /**
   * The last text this component emitted.
   *
   * The card editor echoes every `onchange` straight back as a new `value`, so
   * without this the editor would reset its own document — and the caret with
   * it — on every keystroke. Comparing against what we sent tells an echo
   * apart from a real external change, which is what opening a different card
   * looks like.
   */
  let emitted = '';

  /**
   * The last text committed, i.e. sent without `input: true`.
   *
   * A native textarea fires `change` on blur only when the value actually
   * changed, and the card editor treats that event as "save this card". Firing
   * it on every blur would write the board — and bump its Yjs state — each time
   * the user tabbed past an untouched description.
   */
  let committed = '';

  function handleDiagnosticMenu(
    diagnostic: Diagnostic,
    event: MouseEvent,
    context: DiagnosticMenuContext
  ) {
    openDiagnosticPopover(
      { diagnostic, anchor: diagnosticAnchorFrom(event), ...context },
      suggestFor
    );
  }

  /**
   * Styled to be the textarea it replaced, in SVAR's own variables rather than
   * the app's: this lives inside the kanban theme, and hard-coding app colours
   * here would make the description the one field in the form that ignores the
   * Willow/WillowDark switch.
   */
  const theme = EditorView.theme({
    '&': {
      minHeight: '100px',
      width: 'var(--wx-input-width)',
      maxWidth: '100%',
      fontFamily: 'var(--wx-input-font-family)',
      fontSize: 'var(--wx-input-font-size)',
      fontWeight: 'var(--wx-input-font-weight)',
      color: 'var(--wx-input-font-color)',
      background: 'var(--wx-input-background)',
      border: 'var(--wx-input-border)',
      borderRadius: 'var(--wx-input-border-radius)'
    },
    '&.cm-focused': {
      outline: 'none',
      border: 'var(--wx-input-border-focus)'
    },
    '.cm-content': {
      padding: 'var(--wx-input-padding)',
      lineHeight: 'var(--wx-input-line-height)',
      caretColor: 'var(--wx-input-font-color)'
    },
    '.cm-line': { padding: '0' },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: 'var(--wx-input-line-height)',
      overflowY: 'auto',
      maxHeight: '240px'
    },
    '.cm-cursor': { borderLeftColor: 'var(--wx-input-font-color)' },
    '.cm-placeholder': { color: 'var(--wx-input-placeholder-color)' }
  });

  const errorTheme = EditorView.theme({
    '&': {
      borderColor: 'var(--wx-color-danger)',
      color: 'var(--wx-color-danger)'
    }
  });

  const disabledTheme = EditorView.theme({
    '&': {
      cursor: 'not-allowed',
      border: 'var(--wx-input-border-disabled)',
      color: 'var(--wx-color-font-disabled)',
      background: 'var(--wx-input-background-disabled)'
    }
  });

  function extensions(): Extension[] {
    const editable = !disabled && !readonly;
    return [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      placeholder(placeholderText),
      theme,
      error ? errorTheme : [],
      disabled ? disabledTheme : [],
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
      // One checker, one set of squiggles — the same reason the note editors
      // switch the webview's off (crepe-setup.ts explains the `autocorrect`
      // half, which is the one the Android keyboard actually reads).
      EditorView.contentAttributes.of({
        spellcheck: 'false',
        autocorrect: 'off'
      }),
      sourceDiagnostics({
        check: checkSegments,
        syntax: plainSyntax,
        enabled: spellcheckEnabled,
        subscribeInvalidate: subscribeDiagnosticsInvalidated,
        onRequestMenu: handleDiagnosticMenu,
        onDismissMenu: closeDiagnosticPopover
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        emitted = update.state.doc.toString();
        onchange?.({ value: emitted, input: true });
      }),
      EditorView.domEventHandlers({
        blur: (_event, v) => {
          const text = v.state.doc.toString();
          if (text === committed) return false;
          committed = text;
          onchange?.({ value: text });
          return false;
        }
      })
    ];
  }

  onMount(() => {
    if (!host) return;
    emitted = value;
    committed = value;
    configuration = JSON.stringify([
      disabled,
      readonly,
      error,
      placeholderText
    ]);
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions: extensions() })
    });
    return () => {
      view?.destroy();
      view = null;
    };
  });

  // A different card opened, or the board changed underneath — but not our own
  // keystroke coming back around.
  $effect(() => {
    const next = value ?? '';
    if (!view || next === emitted) return;
    emitted = next;
    committed = next;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next }
    });
  });

  /**
   * Rebuild wholesale when a gate flips — opening a card from the trash, a
   * collection turning read-only. Cheap because it never happens while typing,
   * and keyed so the first run after mount doesn't discard the configuration
   * it was just built with (which would restart the check on every open).
   */
  let configuration = $state('');
  $effect(() => {
    const key = JSON.stringify([disabled, readonly, error, placeholderText]);
    if (!view || key === configuration) return;
    configuration = key;
    view.dispatch({ effects: StateEffect.reconfigure.of(extensions()) });
  });
</script>

<div
  bind:this={host}
  class="kanban-description-field"
  data-kanban-description
></div>

<style>
  .kanban-description-field {
    display: block;
    width: 100%;
  }
</style>
