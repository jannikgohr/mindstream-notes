/**
 * What a plugin receives and what it may return.
 *
 * These mirror what the app accepts (`src/lib/plugins/effects.ts` and the
 * note-kind and exporter renderers). The app validates every returned value
 * again, so these types say what will work, not what is enforced here.
 */

/** One folder of the vault, as passed in `ctx.folders`. */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * The context every export receives.
 *
 * The backend fills `settings`, `folders` and `now`, and its values win over
 * anything the caller passed. The window adds `activeNoteId` and `locale`.
 * The rest depends on what the call is for: see {@link RenderInput},
 * {@link ExportInput} and {@link TemplateInput}.
 */
export interface Context {
  /** This plugin's settings, keyed by manifest setting id, defaults applied. */
  settings: Record<string, unknown>;
  /** The vault's folder tree. Empty without `notes.read`. */
  folders: Folder[];
  /** The host clock, RFC 3339. */
  now: string;
  activeNoteId?: string | null;
  /** The window's locale, e.g. `en` or `de`. */
  locale?: string;
  [key: string]: unknown;
}

/** What a note kind's `render.export` receives. */
export interface RenderInput extends Context {
  noteId: string;
  noteKind: string;
  body: string;
  sourceLanguage?: string;
}

/** What a note exporter's `export` receives. */
export interface ExportInput extends Context {
  noteId: string;
  noteKind: string;
  title: string;
  body: string;
  format: string;
  /** One-based page requested after a paged export's PDF bootstrap. */
  page?: number;
}

/** What a template's `render` export receives. */
export interface TemplateInput extends Context {
  title?: string;
  body?: string;
  vars?: Record<string, unknown>;
}

/**
 * A declarative action the app performs for the plugin. The plugin never
 * touches the DOM or writes a note itself; it returns one of these.
 */
export type Effect =
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
  | { effect: 'openMenu'; items: MenuItem[] };

/** One entry of an `openMenu` effect. */
export interface MenuItem {
  label: string;
  run: Effect;
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

/** What a note kind's render export returns. */
export interface RenderResult {
  preview?: { mime: string; dataBase64?: string; text?: string };
  diagnostics?: Diagnostic[];
  /** The renderer cannot run here; show the editor without a preview. */
  sourceOnly?: boolean;
}

/** A file to save, or a PDF the app counts before requesting image pages. */
export type ExportResult = {
  diagnostics?: Diagnostic[];
} & (
  | {
      file: { mime: string; suggestedName?: string } & (
        | { dataBase64: string; text?: never }
        | { text: string; dataBase64?: never }
      );
    }
  | { pagesPdf: { mime: 'application/pdf'; dataBase64: string } }
);

/** What a template's render export returns. */
export interface TemplateResult {
  title: string;
  body: string;
}
