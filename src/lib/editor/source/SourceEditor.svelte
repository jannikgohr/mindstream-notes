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
    sourceAutoPair,
    sourceUserMention,
    sourceWikilink
  } from '$lib/editor/plugins';
  import type { WikilinkBridge } from '$lib/editor/plugins/wikilink-bridge.svelte';
  import type { UserMentionBridge } from '$lib/editor/plugins/user-mention-bridge.svelte';
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
    /** `editor.autoPair` — auto-close brackets. Reactive. */
    autoPairEnabled?: boolean;
    /**
     * `editor.wikilinks` — the `[[` note picker. Reactive. Enabling it
     * requires `wikilinkBridge`: that's what carries the menu state the popup
     * component reads. It MUST be this pane's own bridge, distinct from the
     * WYSIWYG editor's — in Split mode both surfaces are live and a bridge
     * holds one set of commit handlers (see `$lib/editor/plugins/source/typeahead`).
     */
    wikilinksEnabled?: boolean;
    wikilinkBridge?: WikilinkBridge | null;
    /** `editor.userMentions` — the `@` user picker. Same bridge contract as
     *  wikilinks above. Reactive. */
    userMentionsEnabled?: boolean;
    userMentionBridge?: UserMentionBridge | null;
  }
  let {
    getInitialText,
    readonly = false,
    tabSize = 2,
    placeholderText = '',
    onInput,
    onFocusSurface,
    autoPairEnabled = false,
    wikilinksEnabled = false,
    wikilinkBridge = null,
    userMentionsEnabled = false,
    userMentionBridge = null
  }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let view: EditorView | null = null;

  /** Marks a `setText` dispatch as document-originated so the update listener
   *  doesn't feed it back to NoteEditor as a user edit (which would loop). */
  const External = Annotation.define<boolean>();

  const readonlyComp = new Compartment();
  const tabComp = new Compartment();
  const featureComp = new Compartment();

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
      // Clear the phone's notch / rounded corners (landscape especially),
      // mirroring what app.css does for the WYSIWYG pane. env() collapses to
      // 0 everywhere else, so the 1.25rem base still wins on desktop.
      paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
      paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
      // Reserve room for the floating mobile toolbar so the caret on the last
      // line can't end up behind it. MobileEditorToolbar publishes the height
      // on documentElement while it's mounted; app.css defines the variable as
      // 0px at :root, so desktop (and read-only mobile, where the pill is
      // hidden) is unaffected without needing to know the platform here.
      paddingBottom: 'calc(1rem + var(--mobile-toolbar-height, 0px))',
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

  /**
   * The local plugins from `$lib/editor/plugins/source`, each gated by its own
   * setting — the same toggles that gate the matching Milkdown plugins in
   * `$lib/editor/crepe-setup.ts`. Skipped entirely (not just no-op'd) when off,
   * so their handlers don't run on every keystroke.
   *
   * Unlike Crepe — whose features can't be flipped after `create()` short of
   * rebuilding the editor, so its toggles only apply on the next note open —
   * CodeMirror reconfigures live, so these take effect the moment the user
   * changes the setting.
   */
  function featureExtensions(): Extension[] {
    const ext: Extension[] = [];
    if (autoPairEnabled) ext.push(sourceAutoPair());
    if (wikilinksEnabled && wikilinkBridge) {
      ext.push(sourceWikilink(wikilinkBridge));
    }
    if (userMentionsEnabled && userMentionBridge) {
      ext.push(sourceUserMention(userMentionBridge));
    }
    return ext;
  }

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
      featureComp.of(featureExtensions()),
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
  // Re-read every gate so a flip of any one of them reconfigures the set.
  $effect(() => {
    void autoPairEnabled;
    void wikilinksEnabled;
    void wikilinkBridge;
    void userMentionsEnabled;
    void userMentionBridge;
    view?.dispatch({ effects: featureComp.reconfigure(featureExtensions()) });
  });

  /**
   * Reconcile the document to `text` as a document-originated change.
   *
   * No-op when the text already matches. Otherwise we compute a MINIMAL diff
   * (shared prefix + suffix, replace only the middle) rather than replacing the
   * whole document. A full replace would reset the caret and scroll position on
   * every reconcile / remote echo; a localized change lets CodeMirror map the
   * existing selection through it, so the caret and viewport stay put.
   */
  export function setText(text: string): void {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === text) return;
    const curLen = current.length;
    const nextLen = text.length;
    // Longest common prefix.
    let start = 0;
    const maxStart = Math.min(curLen, nextLen);
    while (
      start < maxStart &&
      current.charCodeAt(start) === text.charCodeAt(start)
    ) {
      start++;
    }
    // Longest common suffix (not overlapping the prefix).
    let endCur = curLen;
    let endNext = nextLen;
    while (
      endCur > start &&
      endNext > start &&
      current.charCodeAt(endCur - 1) === text.charCodeAt(endNext - 1)
    ) {
      endCur--;
      endNext--;
    }
    view.dispatch({
      // No explicit selection: CodeMirror maps the current selection through
      // this localized change, preserving the caret.
      changes: { from: start, to: endCur, insert: text.slice(start, endNext) },
      annotations: External.of(true)
    });
  }

  /** Replace the remote-collaborator presence markers (from NoteEditor, which
   *  decodes the awareness cursors to source lines). */
  export function setPresence(presence: PeerPresence[]): void {
    view?.dispatch({ effects: setSourcePresence.of(presence) });
  }

  /** Immediately flush a pending debounced edit to the doc (e.g. when the user
   *  hands off to the WYSIWYG pane) so no trailing keystrokes are lost. */
  export function flush(): void {
    if (!inputTimer) return;
    clearTimeout(inputTimer);
    inputTimer = null;
    if (view) onInput(view.state.doc.toString());
  }

  export function focus(): void {
    view?.focus();
  }

  export function getView(): EditorView | null {
    return view;
  }
</script>

<div bind:this={host} class="h-full w-full overflow-hidden text-left"></div>
