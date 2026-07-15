<script lang="ts">
  /**
   * Raw-markdown source editor — a CodeMirror 6 view that reflects and edits
   * the note's live document. It is NOT the source of truth: NoteEditor keeps
   * the Crepe/ProseMirror editor as the Yjs authority and drives this editor in
   * both directions:
   *
   *   - doc → source: `setText()` pushes freshly-serialized markdown in,
   *     tagged with the `External` annotation so the update listener knows the
   *     change came from the document (not the user) and does NOT echo it back.
   *   - source → doc: genuine user edits fire the debounced `onInput`, which
   *     NoteEditor feeds through the collab `applyTemplate` path.
   *
   * CodeMirror's own history backs undo/redo (the shared toolbar/hotkeys route
   * `app.undo`/`app.redo` to it via SOURCE_ACTIONS), so the source surface feels
   * like a normal text editor.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    EditorView,
    keymap,
    lineNumbers,
    placeholder
  } from '@codemirror/view';
  import {
    Compartment,
    EditorState,
    Annotation,
    type Extension
  } from '@codemirror/state';
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab
  } from '@codemirror/commands';
  import {
    HighlightStyle,
    indentUnit,
    syntaxHighlighting
  } from '@codemirror/language';
  import { markdown } from '@codemirror/lang-markdown';
  import { tags as t } from '@lezer/highlight';
  import {
    sourcePresence,
    setSourcePresence,
    type PeerPresence
  } from './source-presence-extension';

  interface Props {
    /** Read once on mount to seed the document with the current markdown. */
    getInitialText: () => string;
    /** Disables editing (trashed / view-only notes). Reactive. */
    readonly?: boolean;
    /** Indent width in spaces. Reactive. */
    tabSize?: number;
    /** Placeholder shown when the document is empty. */
    placeholderText?: string;
    /** Fired (debounced) on genuine user edits with the full document text. */
    onInput: (text: string) => void;
    /** Fired when the source editor gains focus — NoteEditor uses it to mark
     *  the source pane as the active surface for toolbar/hotkey routing. */
    onFocusSurface?: () => void;
  }
  let {
    getInitialText,
    readonly = false,
    tabSize = 2,
    placeholderText = '',
    onInput,
    onFocusSurface
  }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let view: EditorView | null = null;

  /** Marks a `setText` dispatch as document-originated so the update listener
   *  doesn't feed it back to NoteEditor as a user edit (which would loop). */
  const External = Annotation.define<boolean>();

  const readonlyComp = new Compartment();
  const tabComp = new Compartment();

  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  const INPUT_DEBOUNCE_MS = 150;

  function scheduleInput() {
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      inputTimer = null;
      if (view) onInput(view.state.doc.toString());
    }, INPUT_DEBOUNCE_MS);
  }

  // Minimal markdown highlight that leans on theme tokens rather than a fixed
  // palette, so it reads correctly in both light and dark mode.
  const highlight = HighlightStyle.define([
    { tag: t.heading, fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: [t.link, t.url], color: 'var(--primary, currentColor)' },
    { tag: [t.monospace], fontFamily: 'var(--font-mono, monospace)' },
    { tag: [t.meta, t.processingInstruction], color: 'var(--muted-foreground)' }
  ]);

  const theme = EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--foreground)',
      backgroundColor: 'transparent',
      fontSize: '0.875rem'
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      padding: '1rem 1.25rem',
      caretColor: 'var(--foreground)'
    },
    '.cm-scroller': { lineHeight: '1.6' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'oklch(from var(--foreground) l c h / 0.15)'
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
      border: 'none'
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-placeholder': { color: 'var(--muted-foreground)' }
  });

  function baseExtensions(): Extension[] {
    return [
      lineNumbers(),
      history(),
      markdown(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      placeholder(placeholderText),
      readonlyComp.of([
        EditorState.readOnly.of(readonly),
        EditorView.editable.of(!readonly)
      ]),
      tabComp.of([
        indentUnit.of(' '.repeat(tabSize)),
        EditorState.tabSize.of(tabSize)
      ]),
      sourcePresence(),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // Skip document-originated (External) syncs — only real user edits
        // should propagate back to the Yjs doc.
        if (u.transactions.some((tr) => tr.annotation(External))) return;
        scheduleInput();
      }),
      EditorView.domEventHandlers({
        focus: () => {
          onFocusSurface?.();
          return false;
        }
      })
    ];
  }

  onMount(() => {
    if (!host) return;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: getInitialText(),
        extensions: baseExtensions()
      })
    });
  });

  onDestroy(() => {
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = null;
    view?.destroy();
    view = null;
  });

  // Reconfigure readonly / tabSize live without rebuilding the editor.
  $effect(() => {
    view?.dispatch({
      effects: readonlyComp.reconfigure([
        EditorState.readOnly.of(readonly),
        EditorView.editable.of(!readonly)
      ])
    });
  });
  $effect(() => {
    view?.dispatch({
      effects: tabComp.reconfigure([
        indentUnit.of(' '.repeat(tabSize)),
        EditorState.tabSize.of(tabSize)
      ])
    });
  });

  /**
   * Replace the whole document with `text` as a document-originated change.
   * No-op when the text already matches (avoids resetting the selection and
   * fighting the user's caret during Split editing). Best-effort caret
   * preservation by clamping the previous selection into the new length.
   */
  export function setText(text: string): void {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === text) return;
    const prev = view.state.selection.main;
    const anchor = Math.min(prev.anchor, text.length);
    const head = Math.min(prev.head, text.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor, head },
      annotations: External.of(true)
    });
  }

  /** Replace the remote-collaborator presence markers (from NoteEditor, which
   *  decodes the awareness cursors to source lines). */
  export function setPresence(presence: PeerPresence[]): void {
    view?.dispatch({ effects: setSourcePresence.of(presence) });
  }

  export function focus(): void {
    view?.focus();
  }

  export function getView(): EditorView | null {
    return view;
  }
</script>

<div bind:this={host} class="h-full w-full overflow-hidden text-left"></div>
