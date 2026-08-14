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
  import { tags as t } from '@lezer/highlight';
  import {
    sourceAutoPair,
    sourceDiagnostics,
    sourceUserMention,
    sourceWikilink
  } from '$lib/editor/plugins';
  import type { SourceDiagnosticsOptions } from '$lib/editor/plugins';
  import type { WikilinkBridge } from '$lib/editor/plugins/wikilink-bridge.svelte';
  import type { UserMentionBridge } from '$lib/editor/plugins/user-mention-bridge.svelte';
  import {
    sourcePresence,
    setSourcePresence,
    type PeerPresence
  } from './source-presence-extension';
  import { sourceLanguageExtensions } from './languages';

  interface Props {
    /** Read once on mount to seed the document with the current markdown. */
    getInitialText: () => string;
    /** Disables editing (trashed / view-only notes). Reactive. */
    readonly?: boolean;
    /** Indent width in spaces. Reactive. */
    tabSize?: number;
    /** Placeholder shown when the document is empty. */
    placeholderText?: string;
    /** Language mode. Markdown notes get Markdown parsing; plugin languages
     *  fall back to the shared plain-text editor until they contribute a
     *  language service. */
    language?: string;
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
    /**
     * `editor.spellcheck.enabled`, as a PREDICATE read per check so the
     * setting applies to notes that are already open. Mirrors the WYSIWYG
     * pane, which has no choice but to work this way.
     */
    diagnosticsEnabled?: (() => boolean) | null;
    /** Lets the extension re-check when languages or dictionaries change. */
    subscribeDiagnosticsInvalidated?: SourceDiagnosticsOptions['subscribeInvalidate'];
    /** Runs the check; see `$lib/diagnostics/editor-diagnostics`. */
    diagnosticsCheck?: SourceDiagnosticsOptions['check'] | null;
    /** Opens the suggestion popover for a right-clicked diagnostic. */
    onDiagnosticMenu?: SourceDiagnosticsOptions['onRequestMenu'];
    /** Closes it again when the document changes underneath. */
    onDiagnosticMenuDismiss?: SourceDiagnosticsOptions['onDismissMenu'];
  }
  let {
    getInitialText,
    readonly = false,
    tabSize = 2,
    placeholderText = '',
    onInput,
    onFocusSurface,
    language = 'markdown',
    autoPairEnabled = false,
    wikilinksEnabled = false,
    wikilinkBridge = null,
    userMentionsEnabled = false,
    userMentionBridge = null,
    diagnosticsEnabled = null,
    subscribeDiagnosticsInvalidated = undefined,
    diagnosticsCheck = null,
    onDiagnosticMenu = undefined,
    onDiagnosticMenuDismiss = undefined
  }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let view: EditorView | null = null;

  /** Marks a `setText` dispatch as document-originated so the update listener
   *  doesn't feed it back to NoteEditor as a user edit (which would loop). */
  const External = Annotation.define<boolean>();

  const readonlyComp = new Compartment();
  const tabComp = new Compartment();
  const languageComp = new Compartment();
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

  // Source syntax gets its own palette instead of reusing app brand tokens:
  // --primary is grayscale in the default themes, which made code look nearly
  // monochrome in both Markdown and plugin languages.
  const highlight = HighlightStyle.define([
    { tag: t.heading, color: 'var(--cm-syntax-heading)', fontWeight: '700' },
    { tag: t.heading1, color: 'var(--cm-syntax-heading)', fontWeight: '700' },
    { tag: t.heading2, color: 'var(--cm-syntax-heading)', fontWeight: '700' },
    { tag: t.heading3, color: 'var(--cm-syntax-heading)', fontWeight: '700' },
    { tag: t.strong, color: 'var(--cm-syntax-strong)', fontWeight: '700' },
    {
      tag: t.emphasis,
      color: 'var(--cm-syntax-emphasis)',
      fontStyle: 'italic'
    },
    {
      tag: [
        t.keyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.controlKeyword,
        t.processingInstruction
      ],
      color: 'var(--cm-syntax-keyword)',
      fontWeight: '600'
    },
    { tag: [t.string, t.special(t.string)], color: 'var(--cm-syntax-string)' },
    { tag: [t.atom, t.bool, t.unit], color: 'var(--cm-syntax-atom)' },
    { tag: t.number, color: 'var(--cm-syntax-number)' },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: 'var(--cm-syntax-comment)',
      fontStyle: 'italic'
    },
    { tag: [t.variableName, t.name], color: 'var(--cm-syntax-variable)' },
    {
      tag: [t.propertyName, t.attributeName],
      color: 'var(--cm-syntax-property)'
    },
    {
      tag: [t.labelName, t.className, t.typeName],
      color: 'var(--cm-syntax-label)'
    },
    {
      tag: [t.definition(t.variableName), t.definition(t.propertyName)],
      color: 'var(--cm-syntax-definition)',
      fontWeight: '600'
    },
    { tag: t.special(t.variableName), color: 'var(--cm-syntax-function)' },
    {
      tag: [t.operator, t.operatorKeyword],
      color: 'var(--cm-syntax-operator)'
    },
    {
      tag: [t.punctuation, t.bracket, t.separator],
      color: 'var(--cm-syntax-punctuation)'
    },
    {
      tag: [t.link, t.url],
      color: 'var(--cm-syntax-link)',
      textDecoration: 'underline',
      textUnderlineOffset: '2px'
    },
    {
      tag: [t.monospace],
      color: 'var(--cm-syntax-monospace)',
      backgroundColor: 'var(--cm-syntax-monospace-bg)',
      fontFamily: 'var(--font-mono, monospace)'
    },
    {
      tag: [t.meta, t.documentMeta, t.annotation],
      color: 'var(--cm-syntax-meta)'
    },
    { tag: t.list, color: 'var(--cm-syntax-list)' },
    { tag: t.quote, color: 'var(--cm-syntax-quote)', fontStyle: 'italic' },
    { tag: t.contentSeparator, color: 'var(--cm-syntax-punctuation)' },
    {
      tag: t.invalid,
      color: 'var(--destructive)',
      textDecoration: 'wavy underline'
    }
  ]);

  const theme = EditorView.theme({
    '&': {
      '--cm-syntax-heading': '#2563eb',
      '--cm-syntax-strong': '#92400e',
      '--cm-syntax-emphasis': '#be123c',
      '--cm-syntax-keyword': '#7c3aed',
      '--cm-syntax-string': '#15803d',
      '--cm-syntax-atom': '#b45309',
      '--cm-syntax-number': '#c2410c',
      '--cm-syntax-comment': '#64748b',
      '--cm-syntax-variable': '#0f766e',
      '--cm-syntax-property': '#0369a1',
      '--cm-syntax-label': '#9333ea',
      '--cm-syntax-definition': '#0891b2',
      '--cm-syntax-function': '#2563eb',
      '--cm-syntax-operator': '#db2777',
      '--cm-syntax-punctuation': '#475569',
      '--cm-syntax-link': '#0284c7',
      '--cm-syntax-monospace': '#c2410c',
      '--cm-syntax-monospace-bg': 'rgb(248 113 113 / 0.09)',
      '--cm-syntax-meta': '#16a34a',
      '--cm-syntax-list': '#7c3aed',
      '--cm-syntax-quote': '#64748b',
      height: '100%',
      color: 'var(--foreground)',
      backgroundColor: 'transparent',
      fontSize: '0.875rem'
    },
    '.dark &': {
      '--cm-syntax-heading': '#61afef',
      '--cm-syntax-strong': '#e5c07b',
      '--cm-syntax-emphasis': '#e06c75',
      '--cm-syntax-keyword': '#c678dd',
      '--cm-syntax-string': '#98c379',
      '--cm-syntax-atom': '#d19a66',
      '--cm-syntax-number': '#d19a66',
      '--cm-syntax-comment': '#7f8c98',
      '--cm-syntax-variable': '#e5c07b',
      '--cm-syntax-property': '#56b6c2',
      '--cm-syntax-label': '#c678dd',
      '--cm-syntax-definition': '#56b6c2',
      '--cm-syntax-function': '#61afef',
      '--cm-syntax-operator': '#e06c75',
      '--cm-syntax-punctuation': '#abb2bf',
      '--cm-syntax-link': '#56b6c2',
      '--cm-syntax-monospace': '#d19a66',
      '--cm-syntax-monospace-bg': 'rgb(209 154 102 / 0.12)',
      '--cm-syntax-meta': '#98c379',
      '--cm-syntax-list': '#c678dd',
      '--cm-syntax-quote': '#7f8c98'
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
    // Registered unconditionally, like the WYSIWYG pane, so both surfaces
    // answer the same question the same way.
    if (diagnosticsCheck) {
      ext.push(
        sourceDiagnostics({
          check: diagnosticsCheck,
          enabled: diagnosticsEnabled ?? undefined,
          subscribeInvalidate: subscribeDiagnosticsInvalidated,
          onRequestMenu: onDiagnosticMenu,
          onDismissMenu: onDiagnosticMenuDismiss
        })
      );
    }
    return ext;
  }

  function baseExtensions(): Extension[] {
    return [
      lineNumbers(),
      history(),
      languageComp.of(sourceLanguageExtensions(language)),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      // The webview's own spellchecker stays off here for the same reason
      // as in the WYSIWYG pane (see crepe-setup.ts): one checker, one set
      // of squiggles, reachable suggestions.
      EditorView.contentAttributes.of({ spellcheck: 'false' }),
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
    void language;
    view?.dispatch({
      effects: languageComp.reconfigure(sourceLanguageExtensions(language))
    });
  });
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
