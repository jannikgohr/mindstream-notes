/**
 * Public contract for the declarative plugin system.
 *
 * The first plugin slice is intentionally *manifest-only*: a plugin describes
 * templates, settings, commands and localized strings as data — it never ships
 * runnable code. Everything a plugin can do is expressed through the shapes in
 * this file, which keeps the security model small (see docs/plugins) while the
 * registry, permission and integrity surfaces settle.
 *
 * Namespacing rule that runs through the whole system: a plugin owns a stable,
 * dotted `id` (e.g. `com.mindstream.templates.core`). Every runtime identifier
 * derived from a plugin — settings keys, command ids, i18n keys, permission
 * grants — is namespaced under that id so two plugins can never collide and a
 * grant/record can always be traced back to exactly one plugin.
 */

import type {
  DiagnosticGrammar,
  DiagnosticSyntaxId
} from '$lib/diagnostics/syntax';

/**
 * Capabilities a plugin may request in its manifest:
 *   - `templates.contribute` — surface note templates in create menus;
 *   - `noteKinds.contribute` — register plugin-owned note kind/editor surfaces;
 *   - `noteExporters.contribute` — add export actions for built-in or
 *     plugin-owned note kinds;
 *   - `notes.create` — have the app create a note from the plugin's template;
 *   - `notes.read` — a scripted plugin may read note metadata through its
 *     permission-gated host API.
 *   - `pluginArtifacts.download` — let the host download/update declared
 *     plugin artifacts after verifying their pinned digest.
 *   - `pluginStorage.read` / `pluginStorage.write` — let the host read/write
 *     this plugin's isolated mutable data directory.
 *   - `pluginWebviews.allowEval` — let sandboxed plugin webviews use string
 *     evaluation for runtimes that require generated JS glue.
 *   - `nativeTools.runDeclared` — let the host run plugin-declared binaries
 *     resolved from the user's PATH, without shell execution.
 *   - `nativeServices.run` — let the host run a plugin-declared binary as a
 *     long-lived local *preview server* (e.g. `tinymist preview`) and surface
 *     it to the note's preview iframe. Desktop-only.
 * Broad `notes.write` stays deliberately absent — the app, not the plugin,
 * performs the actual note write (see templates.ts).
 */
export type PluginPermission =
  | 'templates.contribute'
  | 'noteKinds.contribute'
  | 'noteExporters.contribute'
  | 'notes.create'
  | 'notes.read'
  | 'pluginArtifacts.download'
  | 'pluginStorage.read'
  | 'pluginStorage.write'
  | 'pluginWebviews.allowEval'
  | 'nativeTools.runDeclared'
  | 'nativeServices.run'
  | 'textCheckers.contribute';

/** All permissions the current app version understands. */
export const KNOWN_PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'templates.contribute',
  'noteKinds.contribute',
  'noteExporters.contribute',
  'notes.create',
  'notes.read',
  'pluginArtifacts.download',
  'pluginStorage.read',
  'pluginStorage.write',
  'pluginWebviews.allowEval',
  'nativeTools.runDeclared',
  'nativeServices.run',
  'textCheckers.contribute'
];

/**
 * Localized strings a plugin contributes, keyed by locale code then by a
 * plugin-local key. Keys are namespaced to `plugins.<pluginId>.<key>` at
 * runtime (see plugin-i18n.ts) so they can never shadow a core app string.
 */
export type PluginI18nContribution = Record<string, Record<string, string>>;

/** A variable a template prompts for / interpolates. */
export interface PluginTemplateVariable {
  /** Plugin-local slug, referenced as `{{id}}` in the templates. */
  id: string;
  labelKey: string;
  type: 'text' | 'date' | 'select';
  default?: string;
  /** Required for `type: 'select'`; ignored otherwise. */
  options?: string[];
  required?: boolean;
}

/**
 * A note template a plugin contributes. It may create a built-in markdown note
 * or one of the plugin-owned note kinds declared in `contributes.noteKinds`.
 * `titleTemplate` / `bodyTemplate` use `{{variable}}` interpolation (see
 * templates.ts) — deliberately declarative, no embedded code.
 */
export interface PluginNoteTemplateContribution {
  /** Plugin-local slug; the app-wide id is `plugins.<pluginId>.<id>`. */
  id: string;
  labelKey: string;
  descriptionKey?: string;
  noteKind: string;
  titleTemplate: string;
  bodyTemplate: string;
  variables?: PluginTemplateVariable[];
  /**
   * Optional backend script macro (`runtime: 'luau'` or `'wasm'`): the name of an
   * exported function `render(ctx) -> { title, body }` that computes the note
   * instead of the declarative `titleTemplate`/`bodyTemplate`. When set, the app
   * runs the script and uses its result; the app — never the script — still
   * performs the note write.
   */
  render?: string;
}

export const PLUGIN_PREVIEW_MIME_TYPES = [
  'text/html',
  'image/svg+xml',
  'text/markdown',
  'text/plain',
  'application/pdf'
] as const;

export type PluginPreviewMimeType = (typeof PLUGIN_PREVIEW_MIME_TYPES)[number];

export const PLUGIN_VIEW_MODE_PREVIEW_ICONS = ['default', 'bookText'] as const;

export type PluginViewModePreviewIcon =
  (typeof PLUGIN_VIEW_MODE_PREVIEW_ICONS)[number];

export type PluginViewModeLabelKey = 'wysiwyg' | 'source' | 'split';

export interface PluginNoteKindRenderContribution {
  /** Exported backend script function name; called with `{ noteId, noteKind, body }`. */
  export: string;
  /** Declares how the returned preview text should be displayed. */
  previewMime?: PluginPreviewMimeType;
  /** UI debounce before re-running the renderer. */
  debounceMs?: number;
  /**
   * A declared `nativeTools` id the renderer needs (e.g. a `typst` binary).
   * The host checks the tool's availability up front: when it's missing — not
   * installed, or a mobile platform where native tools can't run — the editor
   * drops to source-only (no preview) instead of calling the renderer.
   * Requires the plugin to hold `nativeTools.runDeclared`.
   */
  requiresNativeTool?: string;
  /**
   * A declared `nativeServices` id providing a *live preview server* (e.g.
   * `tinymist`). When its binary is available the editor loads the service's
   * frontend in an iframe with bidirectional click-to-source, instead of the
   * `export` renderer — which stays the fallback (used when the service binary
   * isn't installed). Requires `nativeServices.run`.
   */
  previewService?: string;
  /**
   * Optional plugin-owned browser preview runtime. The host loads `entry` into a
   * sandboxed iframe, sends source updates via postMessage, and exposes only
   * verified artifact bytes/Blob URLs listed here. The backend render export
   * remains the fallback and non-browser provider.
   */
  webview?: PluginWebviewPreviewContribution;
}

/** A plugin-owned note kind/editor contribution. */
export interface PluginNoteKindContribution {
  /** Plugin-local slug. The stored note kind is `plugin.<pluginId>.<id>`. */
  id: string;
  labelKey: string;
  descriptionKey?: string;
  /**
   * Safe relative `.svg` path inside the plugin bundle, used as the note-kind's
   * icon everywhere a per-note glyph is shown (file tree, search, note lists,
   * wikilink picker, …). Omitted → the host's generic unknown-kind icon.
   */
  icon?: string;
  /** Source editor language hint for the host UI. */
  sourceLanguage?: string;
  /** Host-owned icon to show for the preview-only view mode toggle. */
  viewModePreviewIcon?: PluginViewModePreviewIcon;
  /**
   * Optional plugin-owned labels for editor view modes. Keys are the host's
   * stable internal mode ids; values are plugin-local i18n keys.
   */
  viewModeLabelKeys?: Partial<Record<PluginViewModeLabelKey, string>>;
  defaultTitle?: string;
  defaultBody?: string;
  render: PluginNoteKindRenderContribution;
}

export const PLUGIN_SOURCE_LANGUAGE_HOST_PROVIDERS = ['typst'] as const;

export type PluginSourceLanguageHostProvider =
  (typeof PLUGIN_SOURCE_LANGUAGE_HOST_PROVIDERS)[number];

/**
 * A source-editor language mode a plugin can opt a note kind into.
 *
 * The provider is deliberately host-owned: plugin manifests choose from
 * providers shipped by the app, but plugin bundles do not inject arbitrary
 * CodeMirror extensions into the editor process.
 */
export interface PluginSourceLanguageContribution {
  /** Plugin-local language id, referenced by `noteKinds[].sourceLanguage`. */
  id: string;
  labelKey?: string;
  aliases?: string[];
  extensions?: string[];
  provider: {
    type: 'host';
    id: PluginSourceLanguageHostProvider;
  };
  /**
   * Opt this language's notes into spelling and grammar checking.
   *
   * The split here is the same one the language provider makes, for the same
   * reason. WHETHER a plugin's notes are prose worth checking is the plugin's
   * call — a Typst document is, a generated log would not be — but HOW to find
   * the prose inside them is the app's, because that code runs on every
   * keystroke of every note in the language and belongs nowhere near a plugin
   * bundle. So the manifest names a syntax the app ships and stops there.
   *
   * Omitted means no checking, which keeps every existing plugin exactly as it
   * was: a squiggle a user did not ask for, in a language the app might read
   * wrong, is worse than no squiggle.
   */
  diagnostics?: PluginDiagnosticsContribution;
}

/**
 * How a plugin's notes should be read when looking for prose.
 *
 * Exactly one of the two. `syntax` names a language the app already has code
 * for; `grammar` describes one it does not, in literal delimiters the host
 * scans with. Naming a host syntax is always preferable where one fits — it is
 * a real parser rather than a span matcher — so the grammar is for languages
 * the app has never heard of.
 */
export interface PluginDiagnosticsContribution {
  /** One of `DIAGNOSTIC_SYNTAX_IDS` — see `$lib/diagnostics/syntax`. */
  syntax?: DiagnosticSyntaxId;
  /**
   * A language described rather than shipped: comment, verbatim and math
   * delimiters, all literal text. Deliberately not patterns — a
   * plugin-supplied regex runs on every keystroke, where catastrophic
   * backtracking is an editor freeze the user cannot escape.
   */
  grammar?: DiagnosticGrammar;
}

export const PLUGIN_NOTE_EXPORT_FORMATS = ['pdf'] as const;

export type PluginNoteExportFormat =
  (typeof PLUGIN_NOTE_EXPORT_FORMATS)[number];

/**
 * A note export action contributed by a plugin. `noteKind` names either a
 * built-in note kind (for extending existing note types) or one of this
 * plugin's fully-qualified note kind ids (`plugin.<pluginId>.<localKind>`).
 */
export interface PluginNoteExporterContribution {
  /** Plugin-local slug. The UI id is `plugin.<pluginId>.<id>`. */
  id: string;
  /** Plugin-local i18n key for the export menu label. */
  labelKey: string;
  noteKind: string;
  format: PluginNoteExportFormat;
  /** Backend script export called with `{ noteId, noteKind, title, body }`. */
  export: string;
  /**
   * Optional declared native tool required by this export. The host checks it
   * before calling the script so failures are immediate and readable.
   * Requires `nativeTools.runDeclared`.
   */
  requiresNativeTool?: string;
}

/** A single generic setting control a plugin adds under its section. */
export interface PluginSetting {
  /** Plugin-local slug; stored under `plugins.<pluginId>.<id>`. */
  id: string;
  labelKey: string;
  descriptionKey?: string;
  /** Reuses the app's vault/device scope model. */
  scope: 'V' | 'D';
  /**
   * Control kind. Besides the basic inputs, `folder` and `tag` are live pickers
   * fed by the vault (the app's reusable picker primitives) — a plugin declares
   * one and the app renders the picker + auto-clears it when the target is
   * deleted; the stored value is a folder id / tag string.
   */
  type:
    | 'toggle'
    | 'select'
    | 'radio'
    | 'number'
    | 'slider'
    | 'color'
    | 'text'
    | 'folder'
    | 'tag';
  default?: unknown;
  /** Required for `select`/`radio`; option labels resolve via plugin i18n. */
  options?: string[];
  /** Optional plugin-local i18n keys for individual option values. */
  optionLabelKeys?: Record<string, string>;
}

/** A subsection of settings a plugin adds under the "Plugins" category. */
export interface PluginSettingsContribution {
  /** Plugin-local slug; the app-wide section id is `plugins.<pluginId>.<sectionId>`. */
  sectionId: string;
  titleKey: string;
  settings: PluginSetting[];
}

export const PLUGIN_ARTIFACT_KINDS = ['wasm', 'webScript', 'data'] as const;
export type PluginArtifactKind = (typeof PLUGIN_ARTIFACT_KINDS)[number];

/**
 * A host-managed binary/blob the plugin needs at runtime. The host downloads
 * and verifies the artifact, then stores it under a per-plugin artifact root.
 *
 * The kind-based shape leaves room for a later native Typst tool declaration
 * without granting arbitrary command execution.
 */
export interface PluginArtifactContribution {
  id: string;
  kind: PluginArtifactKind;
  /** Human/display version of the artifact, independent of plugin version. */
  version: string;
  /** HTTPS URL fetched by the host, never by plugin code. */
  url: string;
  /** Expected SHA-256 digest of the downloaded bytes, lowercase hex. */
  sha256: string;
  /** Stored filename under the artifact version directory. */
  fileName: string;
  /** Optional exact byte length, checked after download when present. */
  sizeBytes?: number;
}

/** A plugin-owned sandboxed iframe preview runtime for a note kind. */
export interface PluginWebviewPreviewContribution {
  /** Safe relative `.js`/`.mjs` module inside the plugin directory. */
  entry: string;
  /**
   * Opt into CSP `unsafe-eval` inside the sandboxed iframe. This is required by
   * some generated WASM JS glue, but stays manifest/permission-gated.
   */
  allowEval?: boolean;
  /**
   * Plugin artifact ids that should be downloaded, verified, and delivered to
   * the iframe as Blob URLs + bytes before rendering.
   */
  artifacts?: string[];
}

/** A PATH-resolved native tool a plugin may request to run. */
export interface PluginNativeToolContribution {
  /** Plugin-local slug. */
  id: string;
  /** Exact executable basename to resolve from PATH; no paths or shell. */
  binaryName: string;
  descriptionKey?: string;
}

export type PluginPreviewIframeMode = 'direct' | 'themed';

export interface PluginPreviewIframeContribution {
  /**
   * `direct` (default) loads the service URL unchanged. `themed` routes it
   * through the host proxy so app theme variables and optional plugin CSS can be
   * injected into the iframe document.
   */
  mode: PluginPreviewIframeMode;
  /**
   * Optional safe relative `.css` file inside the plugin bundle, injected only
   * for `mode: "themed"` after the host theme variables. This is where a plugin
   * maps `--ms-preview-*` onto its frontend's DOM.
   */
  css?: string;
  /**
   * Default WebSocket port the tool's frontend hardcodes as a fallback (e.g.
   * tinymist's 23625). When set (`mode: "themed"` only), the host injects a
   * generic shim that redirects a socket to `127.0.0.1:<port>` back to the proxy
   * origin so it tunnels to the real server. Omit when the frontend derives its
   * socket from `location`.
   */
  socketRewritePort?: number;
}

/**
 * A long-lived **preview service**: a PATH binary the host runs as a persistent
 * local server whose web frontend is shown in the note's preview iframe. The
 * host allocates the ports and materializes the note body to a temp file the
 * server watches; the plugin only declares how to launch it and how to reach it.
 */
export interface PluginNativeServiceContribution {
  /** Plugin-local slug. */
  id: string;
  /** Exact executable basename to resolve from PATH; no paths or shell. */
  binaryName: string;
  /**
   * Launch argument template. Each entry may contain the placeholders
   * `{dataPort}`, `{controlPort}` (host-allocated free ports) and `{input}`
   * (absolute path to the materialized source file).
   */
  args: string[];
  /** URL the iframe loads, e.g. `http://127.0.0.1:{dataPort}`. */
  dataUrl: string;
  /** Control-plane WebSocket URL, e.g. `ws://127.0.0.1:{controlPort}`. */
  controlUrl: string;
  /** Extension for the materialized source file (default `txt`). */
  inputExtension?: string;
  /**
   * Controls how the service frontend iframe is loaded. Omitted means
   * unmodified/direct, which is the safest and most compatible default.
   */
  previewIframe?: PluginPreviewIframeContribution;
  descriptionKey?: string;
  /**
   * Control-plane message names the host bridge understands. `jumpEvent` is the
   * server→editor inverse-search message (payload `{ filepath, start:[line,col] }`)
   * that moves the source cursor on click.
   */
  protocol?: {
    jumpEvent?: string;
  };
}

/**
 * What a plugin command does. A closed union rather than an arbitrary callback:
 * the app maps each variant onto an app-owned handler, so a command can never
 * smuggle in executable behaviour. Only `createTemplateNote` exists in the MVP.
 */
export type PluginCommandAction = {
  type: 'createTemplateNote';
  /** Plugin-local template id this command creates a note from. */
  templateId: string;
};

/** An app-local (never native/global) command a plugin contributes. */
export interface PluginCommandContribution {
  /** Plugin-local slug; the app-wide id is `plugin.<pluginId>.<id>`. */
  id: string;
  labelKey: string;
  /** A hotkey string (e.g. `mod+alt+m`) or `null` for "no default binding". */
  defaultBinding?: string | null;
  action: PluginCommandAction;
}

/** Host surfaces a plugin may place a toolbar button in. */
export const PLUGIN_TOOLBAR_LOCATIONS = ['file-tree', 'note-editor'] as const;
export type PluginToolbarLocation = (typeof PLUGIN_TOOLBAR_LOCATIONS)[number];

export const PLUGIN_EDITOR_TOOLBAR_ITEMS = [
  'bold',
  'italic',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ordered',
  'bullet',
  'task',
  'image',
  'code',
  'table',
  'math',
  'mermaid'
] as const;

export type PluginEditorToolbarItem =
  (typeof PLUGIN_EDITOR_TOOLBAR_ITEMS)[number];

/** Host-owned text edits a plugin toolbar button may apply to a source editor. */
export type PluginSourceEditAction =
  | {
      type: 'insertText';
      text: string;
      /** Optional caret offset inside `text` after insertion. */
      cursorOffset?: number;
    }
  | {
      type: 'wrapSelection';
      before: string;
      after: string;
      /** Text inserted and selected when the current selection is empty. */
      placeholder?: string;
    };

/**
 * What a toolbar button does when clicked. A closed union so a button can only
 * pick a host-understood mechanism, never smuggle code. Currently the sole kind
 * runs a backend script export whose *return value* is a {@link PluginEffect} the host
 * performs — which is what lets one button be either a single action or a
 * sub-menu (the script decides by returning a terminal effect vs. `openMenu`).
 */
export type PluginToolbarAction =
  | {
      type: 'script';
      /** Exported backend script function name; called with the button `ctx` on click. */
      export: string;
    }
  | PluginSourceEditAction;

/** A toolbar button a plugin contributes into a host surface. */
export interface PluginToolbarButton {
  /** Plugin-local slug; the app-wide id is `plugin.<pluginId>.<id>`. */
  id: string;
  location: PluginToolbarLocation;
  /** Plugin-local note kind id when `location` is `note-editor`. */
  noteKind?: string;
  /** Built-in editor toolbar primitive to render for source-edit buttons. */
  toolbarItem?: PluginEditorToolbarItem;
  /** Plugin i18n key for the tooltip / aria-label. Defaults to the built-in
   *  toolbar primitive label when `toolbarItem` is set. */
  labelKey?: string;
  /** Safe relative path to a bundled `.svg` icon (rendered themed via a mask). */
  icon?: string;
  /** The script returns an `openMenu` effect. Hosts show a submenu affordance
   * and may resolve it on hover. */
  opensMenu?: boolean;
  action: PluginToolbarAction;
}

/**
 * A declarative effect a plugin's backend script returns for the host to perform — the
 * plugin computes, the app acts (the runtime's "a script never writes" rule).
 * A closed union: the host executes only these, permission-gated. `openMenu`
 * nests effects, so a script can return a whole sub-menu of actions from one
 * call (e.g. a template picker).
 */
export type PluginEffect =
  | { effect: 'none' }
  | { effect: 'toast'; message: string; kind?: 'info' | 'error' }
  | {
      effect: 'createNote';
      title: string;
      body: string;
      noteKind?: string;
      parentId?: string | null;
    }
  | {
      effect: 'createNoteFromNote';
      sourceNoteId: string;
      parentId?: string | null;
    }
  | { effect: 'insertMarkdown'; markdown: string }
  | { effect: 'openMenu'; items: PluginEffectMenuItem[] };

/** One item in an `openMenu` effect: a label plus the effect to run on select. */
export interface PluginEffectMenuItem {
  label: string;
  run: PluginEffect;
}

/**
 * One navigable section of a plugin's documentation, backed by a real markdown
 * file bundled in the plugin dir (authoring long-form docs inline in JSON is
 * miserable). Sections render in declaration order; the nav label is the file's
 * first `# H1` (falling back to a prettified filename).
 *
 * Localization is by filename suffix: for `file: "docs/guide.md"` and active
 * locale `de`, the app loads `docs/guide.de.md`, falling back to
 * `docs/guide.md` — the same active-locale→English fallback used everywhere.
 */
export interface PluginDocSection {
  /**
   * Safe relative path (POSIX `/`) to a `.md` file inside the plugin dir. No
   * `..`, no absolute paths, no backslashes — the loader joins it onto the
   * plugin dir, so this is a traversal boundary (validated).
   */
  file: string;
}

/** The `contributes` block of a manifest. Every field is optional. */
/**
 * Wire protocols a text checker can speak.
 *
 * Host-owned, exactly like `PLUGIN_SOURCE_LANGUAGE_HOST_PROVIDERS`: a
 * manifest picks from protocols the app ships an implementation for, rather
 * than supplying its own transport. That is what keeps a checker a
 * declaration instead of arbitrary code with access to every note's text.
 * A second protocol is added here, not in a plugin bundle.
 */
/** How the request body carries its fields. */
export type PluginCheckerEncoding = 'form' | 'json';

/**
 * Where a value lives in the server's JSON, as a JSON Pointer (RFC 6901).
 *
 * Pointers rather than a query language on purpose: they are a standard, they
 * cannot loop or backtrack, and `serde_json` resolves them natively. A service
 * whose response cannot be described by pointers is out of scope for a
 * declarative protocol — see docs/plugins for where that boundary sits.
 */
export type PluginJsonPointer = string;

/** How to build the check request. */
export interface PluginCheckerRequestSpec {
  /** Appended to the user's endpoint, e.g. `/v2/check`. */
  path: string;
  encoding: PluginCheckerEncoding;
  /**
   * Names the host's values take in the request. A field left out is not sent,
   * which is how a server that has no concept of (say) an API key simply omits
   * it rather than declaring an empty name.
   */
  fields: {
    /** REQUIRED — the field carrying the text to check. */
    text: string;
    language?: string;
    apiKey?: string;
    username?: string;
    /** Sent only alongside automatic language selection. */
    preferredVariants?: string;
    /** Carries `disabledCategories`, joined with commas. */
    disabledCategories?: string;
  };
  /** Fixed fields sent verbatim on every request. */
  staticFields?: Record<string, string>;
}

/** Where the findings are in the response. All pointers are match-relative
 *  except `list`, which is document-relative. */
export interface PluginCheckerMatchSpec {
  /** Pointer to the array of findings. */
  list: PluginJsonPointer;
  /** Start of the finding, in characters from the start of the sent text. */
  offset: PluginJsonPointer;
  /** Exactly one of these: a length, or an end offset. */
  length?: PluginJsonPointer;
  end?: PluginJsonPointer;
  message: PluginJsonPointer;
  /** Pointer to the suggestions array. Omit if the service offers none. */
  replacements?: PluginJsonPointer;
  /**
   * Pointer INTO each replacement entry, when they are objects rather than
   * plain strings — LanguageTool returns `{ "value": "…" }`.
   */
  replacementValue?: PluginJsonPointer;
  /** The service's rule category, mapped to a diagnostic kind by `categoryKinds`. */
  category?: PluginJsonPointer;
}

/**
 * Optional: where the service reports the language it detected.
 *
 * Declaring it switches on the host's re-ask behaviour — when detection is not
 * confident enough, or lands outside the languages the user writes, the host
 * repeats the request naming a language outright. Checking German prose against
 * a French dictionary produces far more nonsense than a wrong regional variant.
 */
export interface PluginCheckerDetectionSpec {
  code: PluginJsonPointer;
  confidence: PluginJsonPointer;
}

/**
 * Optional: a cheap endpoint that lists the languages the server offers, used
 * by the "test connection" button.
 *
 * Kept apart from the check path because the point is to send NOTHING — the
 * common question is "is my container up?", and answering it should not
 * transmit text anywhere.
 */
export interface PluginCheckerProbeSpec {
  path: string;
  /** Pointer to the list; empty string is the document root. */
  list: PluginJsonPointer;
  /** Pointer into each entry for its BCP-47 tag, tried in order. */
  languageCode: PluginJsonPointer[];
}

/**
 * Everything the host needs to talk to a checking service, as data.
 *
 * This replaces a host-owned allow-list of protocol names. That list had one
 * entry, `languagetool`, and its client lived in the app — so a second service
 * meant editing the app and shipping a release, and a third-party plugin could
 * not add one at all. The service's wire format is the plugin's business; the
 * request, the egress and the rendering stay the host's.
 *
 * The host still makes every request, which is what keeps the strong property:
 * a plugin never receives note text and cannot choose where it goes. Only the
 * SHAPE is declared.
 */
export interface PluginCheckerProtocol {
  /**
   * A path suffix to strip from the user's endpoint before appending paths.
   *
   * Users paste whatever their server's docs show — often the API root
   * including a version segment — which would otherwise build `/v2/v2/check`
   * and 404 as an unreachable server rather than a URL one segment too long.
   */
  trimEndpointSuffix?: string;
  check: PluginCheckerRequestSpec;
  matches: PluginCheckerMatchSpec;
  detection?: PluginCheckerDetectionSpec;
  probe?: PluginCheckerProbeSpec;
}

/**
 * A checker a plugin adds to the diagnostics pipeline.
 *
 * Deliberately DECLARATIVE — the plugin describes an endpoint, and the host
 * makes the request and renders the result. It never receives note text or
 * returns rendered UI. Two reasons: with Yjs underneath, a checker that
 * could edit the document would fight collaborative updates, and a checker
 * that drew its own squiggles would make the source and WYSIWYG panes
 * disagree. Plugins supply findings; the host owns the document and the
 * pixels.
 *
 * Gated by `textCheckers.contribute`, its own permission rather than
 * `notes.read`, because a checker sees the full text of every note the user
 * types in — including ones it would never otherwise be granted.
 */
export interface PluginTextCheckerContribution {
  /** Namespaced to `plugins.<pluginId>.<id>` at runtime, like settings. */
  id: string;
  /**
   * Kinds this checker may emit. Declared so overlapping providers can be
   * de-conflicted without running them — the built-in dictionary owns
   * spelling, so a grammar service should not also claim it.
   */
  kinds: ('spelling' | 'grammar' | 'style')[];
  /** How to talk to the service, declared rather than named. */
  protocol: PluginCheckerProtocol;
  /**
   * Id of the plugin setting holding the server URL.
   *
   * A setting rather than a manifest value because the endpoint is the
   * user's choice — their own self-hosted instance, or the public API with
   * its rate limits and its very different privacy implications.
   */
  endpointSetting: string;
  /** Id of the plugin setting holding an API key, when the server needs one. */
  apiKeySetting?: string;
  /**
   * Id of the plugin setting holding an account name. LanguageTool's public
   * API authenticates with username and key together; self-hosted servers
   * usually need neither.
   */
  usernameSetting?: string;
  /** Rule categories to switch off server-side, always. */
  disabledCategories?: string[];
  /**
   * Id of the plugin setting toggling whether this checker does spelling.
   *
   * Declaring `spelling` in `kinds` says it CAN; this setting says whether it
   * does, so a user can keep the built-in dictionary's behaviour without
   * disabling the plugin. Omitted means it always does.
   */
  spellingSetting?: string;
  /**
   * Categories to disable when this checker is NOT doing spelling.
   *
   * Named by the plugin because they are the service's vocabulary — the host
   * has no idea that LanguageTool calls its spelling rules `TYPOS`. Switching
   * them off server-side avoids paying for findings that would be discarded,
   * and avoids one word carrying two underlines whose fixes disagree.
   */
  spellingCategories?: string[];
  /**
   * The service's rule categories mapped to diagnostic kinds.
   *
   * Also the service's vocabulary, and previously a hardcoded set of
   * LanguageTool ids — including German-only ones — sitting in app code.
   * Anything unlisted falls back to `defaultKind`.
   */
  categoryKinds?: Record<string, 'spelling' | 'grammar' | 'style'>;
  /** Kind for categories `categoryKinds` does not name. Defaults to grammar. */
  defaultKind?: 'spelling' | 'grammar' | 'style';
  /** i18n key for the name shown in the suggestion popover. */
  labelKey?: string;
}

export interface PluginContributions {
  i18n?: PluginI18nContribution;
  settings?: PluginSettingsContribution[];
  artifacts?: PluginArtifactContribution[];
  nativeTools?: PluginNativeToolContribution[];
  nativeServices?: PluginNativeServiceContribution[];
  sourceLanguages?: PluginSourceLanguageContribution[];
  noteExporters?: PluginNoteExporterContribution[];
  noteTemplates?: PluginNoteTemplateContribution[];
  noteKinds?: PluginNoteKindContribution[];
  commands?: PluginCommandContribution[];
  textCheckers?: PluginTextCheckerContribution[];
  /** Ordered, file-backed documentation sections shown in the docs modal. */
  documentation?: PluginDocSection[];
  /** Toolbar buttons the plugin places into host surfaces (file-tree, …). */
  toolbar?: PluginToolbarButton[];
}

export interface PluginRuntimeLimits {
  /** Guest memory cap in bytes. Clamped by the backend. */
  memoryBytes?: number;
  /** Wall-clock timeout in milliseconds. Clamped by the backend. */
  timeoutMs?: number;
  /** Wasmi fuel budget (`runtime: 'wasm'` only). Clamped by the backend. */
  fuel?: number;
}

/**
 * A plugin manifest.
 *
 * `runtime` selects how the plugin's contributions are produced:
 *   - `'manifest-only'` — purely declarative; no executable code (the original
 *     and still the default slice). Everything comes from the data above.
 *   - `'luau'` — the plugin ships a sandboxed Luau `entry` script the Rust
 *     backend runs to produce dynamic output (e.g. computed template
 *     title/body). The script gets a permission-gated host API (`ms.*`); the
 *     app, not the script, still performs any note write. `entry` is required
 *     and must be a safe relative `.luau` filename inside the plugin dir.
 *   - `'wasm'` — the plugin ships a backend-only WebAssembly `entry` run by
 *     Wasmi with no WASI by default. It uses the same exported-function and
 *     declarative-effect boundary as Luau; `entry` must be a safe `.wasm`
 *     filename.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Optional author/publisher, shown verbatim under the plugin in settings
   * ("By <author>"). A plain display string — not translated and not an i18n
   * key — so it reads the same in every locale, matching how plugin catalogues
   * (Obsidian, VS Code) surface authorship.
   */
  author?: string;
  /**
   * Builtin plugins are enabled on first discovery unless this is false.
   * Third-party plugins ignore this and always start gated/disabled.
   */
  enabledByDefault?: boolean;
  runtime: 'manifest-only' | 'luau' | 'wasm';
  /** Required for scripted runtimes; a `.luau`/`.wasm` file relative to the plugin dir. */
  entry?: string;
  /** Optional per-runtime resource limits. The backend applies hard maximums. */
  limits?: PluginRuntimeLimits;
  /**
   * Optional i18n key for a **short** one-line description (a tagline) shown
   * next to the plugin in settings. Resolves against the plugin's own i18n
   * bundle.
   */
  descriptionKey?: string;
  /**
   * Optional safe relative `.svg` path to the plugin's representative icon,
   * rendered themed (via a mask, like the built-in Lucide glyphs) wherever the
   * plugin is listed as a whole — e.g. the settings rail. Omitted → the host's
   * generic plugin glyph.
   */
  icon?: string;
  permissions: PluginPermission[];
  contributes: PluginContributions;
}
