/**
 * Synthetic vault content shaped like what the app syncs.
 *
 * The server only ever sees ciphertext, so what matters is that the encoded
 * sizes and the item layout match the real thing: a note item is a msgpack
 * `NotePayload` carrying the Yjs state, a markdown mirror of the body and the
 * per-note key (src-tauri/src/sync/payloads.rs), and an asset item is a
 * msgpack `AssetPayload` with the blob inline.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as Y from 'yjs';

const require = createRequire(import.meta.url);
// msgpack isn't a dependency of this repo; borrow the copy the SDK ships with.
const msgpack = createRequire(require.resolve('etebase'))('@msgpack/msgpack');

export const ITEM_TYPE_NOTE = 'ms-md-note';
export const ITEM_TYPE_ASSET = 'ms-md-asset';
export const ITEM_TYPE_COLLAB_WRITER_KEY = 'ms-collab-writer-key';

const PARAGRAPH =
  'Local-first notes keep the database on the device and treat the server ' +
  'as a relay for ciphertext. Every body is a CRDT, so two devices that ' +
  'edit the same paragraph offline both keep their words when they meet ' +
  'again. The server never learns what either of them wrote.';

function markdownBody(bytes, title) {
  let body = `# ${title}\n\n`;
  while (body.length < bytes) body += `${PARAGRAPH}\n\n`;
  return body.slice(0, bytes);
}

export function decodePayload(bytes) {
  return msgpack.decode(bytes);
}

/** One note with a live Yjs document, so edits grow it the way typing does. */
export class BenchNote {
  constructor(index, bodyBytes) {
    this.id = randomUUID();
    this.title = `Bench note ${index}`;
    this.doc = new Y.Doc();
    this.doc.getText('body').insert(0, markdownBody(bodyBytes, this.title));
    this.created = new Date().toISOString();
    /** Etebase item uid, set once the note has been pushed. */
    this.uid = null;
    this.edits = 0;
  }

  /** Append a sentence, as a short burst of typing between two syncs would. */
  edit() {
    const text = this.doc.getText('body');
    this.edits += 1;
    text.insert(text.length, ` Edit ${this.edits} lands here.`);
  }

  meta() {
    return { type: ITEM_TYPE_NOTE, name: this.title, mtime: Date.now() };
  }

  /** The full payload. The app re-sends all of it on every push. */
  payload(cryptoKey) {
    return msgpack.encode({
      schema: 2,
      id: this.id,
      parent_folder_id: null,
      title: this.title,
      position: 0,
      created: this.created,
      modified: new Date().toISOString(),
      tags: [],
      tags_state: new Uint8Array(0),
      trashed_at: null,
      yrs_state: Y.encodeStateAsUpdate(this.doc),
      body: this.doc.getText('body').toString(),
      crypto_key: cryptoKey,
      favourite: false,
      note_kind: 'markdown'
    });
  }
}

export function makeAsset(bytes) {
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    meta: { type: ITEM_TYPE_ASSET, name: id, mtime: Date.now() },
    payload: msgpack.encode({
      schema: 1,
      id,
      owning_note_id: null,
      mime_type: 'image/png',
      // Random, so the content-defined chunker finds nothing to dedupe,
      // like a photo, unlike a file of zeros.
      bytes: randomBytes(bytes),
      size: bytes,
      created: now,
      modified: now
    })
  };
}
