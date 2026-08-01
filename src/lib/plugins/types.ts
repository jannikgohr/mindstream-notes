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

/**
 * Capabilities a plugin may request in its manifest:
 *   - `templates.contribute` — surface note templates in create menus;
 *   - `noteKinds.contribute` — register plugin-owned note kind/editor surfaces;
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
 * Broad `notes.write` stays deliberately absent — the app, not the plugin,
 * performs the actual note write (see templates.ts).
 */
export type PluginPermission =
  | 'templates.contribute'
  | 'noteKinds.contribute'
  | 'notes.create'
  | 'notes.read'
  | 'pluginArtifacts.download'
  | 'pluginStorage.read'
  | 'pluginStorage.write'
  | 'pluginWebviews.allowEval'
  | 'nativeTools.runDeclared';

/** All permissions the current app version understands. */
export const KNOWN_PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'templates.contribute',
  'noteKinds.contribute',
  'notes.create',
  'notes.read',
  'pluginArtifacts.download',
  'pluginStorage.read',
  'pluginStorage.write',
  'pluginWebviews.allowEval',
  'nativeTools.runDeclared'
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
  'text/plain'
] as const;

export type PluginPreviewMimeType = (typeof PLUGIN_PREVIEW_MIME_TYPES)[number];

export const PLUGIN_VIEW_MODE_PREVIEW_ICONS = ['default', 'bookText'] as const;

export type PluginViewModePreviewIcon =
  (typeof PLUGIN_VIEW_MODE_PREVIEW_ICONS)[number];

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
  /** Source editor language hint for the host UI. */
  sourceLanguage?: string;
  /** Host-owned icon to show for the preview-only view mode toggle. */
  viewModePreviewIcon?: PluginViewModePreviewIcon;
  defaultTitle?: string;
  defaultBody?: string;
  render: PluginNoteKindRenderContribution;
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
export interface PluginContributions {
  i18n?: PluginI18nContribution;
  settings?: PluginSettingsContribution[];
  artifacts?: PluginArtifactContribution[];
  nativeTools?: PluginNativeToolContribution[];
  noteTemplates?: PluginNoteTemplateContribution[];
  noteKinds?: PluginNoteKindContribution[];
  commands?: PluginCommandContribution[];
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
  permissions: PluginPermission[];
  contributes: PluginContributions;
}
