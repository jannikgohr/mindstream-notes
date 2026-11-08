/**
 * Native export sessions — mirror of `src-tauri/src/export_session.rs`.
 *
 * Every file goes to Rust in chunks of at most `CHUNK_BYTES`, and stored
 * assets are copied natively, so an export never crosses IPC whole. On
 * Android the bridge turns each request into JSON, so a large single
 * payload could cost the app its memory.
 */

import {
  assertBoolean,
  assertRecord,
  assertString,
  assertVoid,
  invokeFile,
  invokeTauri,
  TauriCommandName
} from './core';

/** Bytes per IPC request. Small enough to stay cheap as JSON on Android. */
export const CHUNK_BYTES = 1024 * 1024;

export type ExportTarget =
  | { kind: 'folder'; root: string }
  | { kind: 'archive' }
  | { kind: 'file' };

export interface ExportSaveOptions {
  suggestedName: string;
  dialogTitle?: string;
  filterName: string;
  extensions: string[];
}

export class ExportSession {
  private constructor(private readonly token: string) {}

  static async begin(target: ExportTarget): Promise<ExportSession> {
    const token = assertString(
      await invokeTauri<unknown>(TauriCommandName.ExportBegin, { target }),
      'export_begin response'
    );
    return new ExportSession(token);
  }

  /** Write a whole file. Arrow function so it can be passed as a writer. */
  write = async (path: string, bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    do {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      assertVoid(
        await invokeFile<unknown>(
          TauriCommandName.ExportWrite,
          {
            token: this.token,
            path,
            first: offset === 0,
            size: bytes.length
          },
          chunk
        ),
        'export_write response'
      );
      offset += chunk.length;
    } while (offset < bytes.length);
  };

  /** Copy a stored asset into the export without loading it here. */
  copyAsset = async (
    path: string,
    assetId: string,
    mimeType?: string
  ): Promise<void> => {
    assertVoid(
      await invokeTauri<unknown>(TauriCommandName.ExportCopyAsset, {
        token: this.token,
        path,
        assetId,
        mimeType
      }),
      'export_copy_asset response'
    );
  };

  /**
   * Finish the export. A staged archive or file asks where to save it first,
   * and resolves `false` when the user cancels. Folder exports resolve true.
   */
  async finish(save?: ExportSaveOptions): Promise<boolean> {
    return assertBoolean(
      await invokeTauri<unknown>(TauriCommandName.ExportFinish, {
        token: this.token,
        save
      }),
      'export_finish response'
    );
  }

  /** Drop the export and its staged files. Never throws. */
  async abort(): Promise<void> {
    try {
      await invokeTauri<unknown>(TauriCommandName.ExportAbort, {
        token: this.token
      });
    } catch (err) {
      console.warn('[export] abort failed', err);
    }
  }
}

/**
 * Save one file through the native save dialog. The bytes are staged in
 * chunks first, so a large export never crosses IPC whole. Resolves `false`
 * when the user cancels the dialog.
 */
export async function saveFileNatively(
  file: ExportSaveOptions & { bytes: Uint8Array }
): Promise<boolean> {
  const { bytes, ...save } = file;
  const session = await ExportSession.begin({ kind: 'file' });
  try {
    await session.write(save.suggestedName, bytes);
  } catch (err) {
    await session.abort();
    throw err;
  }
  return session.finish(save);
}

/** MIME types of stored assets, keyed by id. Unknown ids are left out. */
export async function exportAssetTypes(
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const raw = assertRecord(
    await invokeTauri<unknown>(TauriCommandName.ExportAssetTypes, { ids }),
    'export_asset_types response'
  );
  return new Map(
    Object.entries(raw).map(([id, mime]) => [
      id,
      assertString(mime, 'export_asset_types mime type')
    ])
  );
}
