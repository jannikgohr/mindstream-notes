/**
 * A "device": the Etebase call sequences the app's Rust client makes, replayed
 * through the JS SDK.
 *
 * Each method names the Rust function it mirrors and issues the same requests
 * in the same order, because the request sequence is the thing being measured.
 * The app's client is sequential (etebase-rs is blocking), so nothing here
 * runs in parallel either. When the Rust side changes how it talks to the
 * server, change it here too or the numbers stop describing the app.
 *
 * Local SQLite work is not modelled. Client-side crypto is, but through
 * libsodium's WASM build where the app uses native code, so wall times for
 * crypto-heavy scenarios run higher here than in the app. Request counts,
 * bytes and time spent in HTTP are unaffected by that.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { meteredGet } from './meter.mjs';
import {
  decodePayload,
  ITEM_TYPE_COLLAB_WRITER_KEY,
  makeAsset
} from './workload.mjs';

const require = createRequire(import.meta.url);
const Etebase = require('etebase');

const VAULT_KINDS = ['folders', 'notes', 'assets', 'signatures'];
const SCOPE_PARTS = ['folders', 'notes', 'assets'];
const COLLECTION_TYPES = {
  folders: 'mindstream.folders',
  notes: 'mindstream.notes',
  assets: 'mindstream.assets',
  signatures: 'mindstream.signatures'
};
const COLLECTION_TYPE_SHARE_MANIFEST = 'mindstream.share_manifest';

/** Throwaway credentials, unique per run so an un-reset stack never collides. */
export function freshCredentials(role) {
  const token = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  return {
    username: `bench-${role}-${token}`,
    email: `bench-${role}-${token}@bench.local`,
    password: `bench-${token}-passphrase`
  };
}

export async function signup(serverUrl, credentials) {
  await Etebase.ready;
  return Etebase.Account.signup(
    { username: credentials.username, email: credentials.email },
    credentials.password,
    serverUrl
  );
}

export async function login(serverUrl, credentials) {
  await Etebase.ready;
  return Etebase.Account.login(
    credentials.username,
    credentials.password,
    serverUrl
  );
}

function manifestOf(manifestCollection) {
  return manifestCollection
    .getContent(Etebase.OutputFormat.String)
    .then((json) => JSON.parse(json));
}

function partUid(manifest, part) {
  return manifest.collections.find((ref) => ref.part === part)?.collection_uid;
}

export class Device {
  /** @param account A signed-in `Etebase.Account`. */
  constructor(serverUrl, account) {
    this.serverUrl = serverUrl;
    this.account = account;
    this.cm = account.getCollectionManager();
    /** kind → { uid, stoken }: what the app keeps in `sync_state`. */
    this.vault = {};
    /** share_scope_id → { folders, notes, assets }, each { uid, stoken }. */
    this.scopes = new Map();
  }

  /**
   * A second device on the same account: same session, none of the cursors.
   * Restoring the saved session instead of logging in again keeps the run
   * clear of the edge's auth rate limit (10 requests a minute).
   */
  async secondDevice() {
    const restored = await Etebase.Account.restore(await this.account.save());
    return new Device(this.serverUrl, restored);
  }

  // ---------- sync::run ----------

  /**
   * One full sync, as `sync::run` behind the scheduler tick or `sync_now`:
   * reachability probe, vault pull, scope sync, then the push phase.
   */
  async sync({ newNotes = [], editedNotes = [] } = {}) {
    await meteredGet(`${this.serverUrl}/healthz`); // preflight_reachable
    const scopePartUids = await this.shareScopePartUids();
    const collections = {};
    for (const kind of VAULT_KINDS) {
      collections[kind] = await this.ensureCollection(kind, scopePartUids);
    }
    for (const kind of VAULT_KINDS) {
      await this.pull(this.vault[kind], collections[kind]);
    }
    await this.syncScopes();
    await this.pushNotes(collections.notes, { newNotes, editedNotes });
  }

  /** `load_share_scope_part_uids`: lists every manifest before each sync. */
  async shareScopePartUids() {
    const list = await this.cm.list(COLLECTION_TYPE_SHARE_MANIFEST);
    const uids = new Set();
    for (const manifestCollection of list.data) {
      if (manifestCollection.isDeleted) continue;
      const manifest = await manifestOf(manifestCollection);
      for (const ref of manifest.collections) uids.add(ref.collection_uid);
    }
    return uids;
  }

  /**
   * `ensure_collection`: fetch the cached vault collection, or on a first sync
   * list by type and adopt the smallest uid, or create one.
   */
  async ensureCollection(kind, scopePartUids) {
    const cached = this.vault[kind];
    if (cached) return this.cm.fetch(cached.uid);

    const type = COLLECTION_TYPES[kind];
    const list = await this.cm.list(type);
    const winner = list.data
      .filter((col) => !col.isDeleted && !scopePartUids.has(col.uid))
      .map((col) => col.uid)
      .sort()[0];
    if (winner) {
      this.vault[kind] = { uid: winner, stoken: null };
      return this.cm.fetch(winner);
    }
    const created = await this.cm.create(
      type,
      { name: `Mindstream ${kind}`, mtime: Date.now() },
      ''
    );
    await this.cm.upload(created);
    this.vault[kind] = { uid: created.uid, stoken: null };
    return created;
  }

  /**
   * `pull_*_once`: page through `list` from the stored stoken and decrypt each
   * item, as `apply_*` does to upsert it. Returns how many items arrived.
   */
  async pull(cursor, collection) {
    const im = this.cm.getItemManager(collection);
    let pulled = 0;
    for (;;) {
      const page = await im.list({ stoken: cursor.stoken });
      for (const item of page.data) {
        if (!item.isDeleted) await item.getContent();
        pulled += 1;
      }
      cursor.stoken = page.stoken ?? cursor.stoken;
      if (page.done) return pulled;
    }
  }

  /** `sync_scopes` + `sync_one_scope` + `reconcile_revoked_shares`. */
  async syncScopes() {
    const list = await this.cm.list(COLLECTION_TYPE_SHARE_MANIFEST);
    for (const manifestCollection of list.data) {
      if (manifestCollection.isDeleted) continue;
      const manifest = await manifestOf(manifestCollection);
      let cursors = this.scopes.get(manifest.share_scope_id);
      if (!cursors) {
        cursors = {};
        for (const part of SCOPE_PARTS) {
          cursors[part] = { uid: partUid(manifest, part), stoken: null };
        }
        this.scopes.set(manifest.share_scope_id, cursors);
      }
      const collections = {};
      for (const part of SCOPE_PARTS) {
        collections[part] = await this.cm.fetch(cursors[part].uid);
      }
      for (const part of SCOPE_PARTS) {
        await this.pull(cursors[part], collections[part]);
      }
    }
    // The reconcile pass returns early when no shared folder exists locally.
    if (this.scopes.size > 0) {
      await this.cm.list(COLLECTION_TYPE_SHARE_MANIFEST, { limit: 100 });
    }
  }

  /**
   * `push_notes`: every dirty row goes into one transaction, and each row that
   * already exists on the server is fetched first, one request per row, to
   * carry its per-note key over.
   */
  async pushNotes(notesCollection, { newNotes = [], editedNotes = [] }) {
    const im = this.cm.getItemManager(notesCollection);
    const items = [];
    for (const note of editedNotes) {
      const existing = await im.fetch(note.uid);
      const { crypto_key: cryptoKey } = decodePayload(
        await existing.getContent()
      );
      existing.setMeta(note.meta());
      await existing.setContent(note.payload(cryptoKey));
      items.push(existing);
    }
    for (const note of newNotes) {
      items.push(await im.create(note.meta(), note.payload(randomBytes(32))));
    }
    if (items.length === 0) return;
    await im.transaction(items);
    newNotes.forEach((note, i) => {
      note.uid = items[editedNotes.length + i].uid;
    });
  }

  /** `push_assets` for new assets: one transaction, blobs inline. */
  async pushAssets(assetsCollection, assets) {
    const im = this.cm.getItemManager(assetsCollection);
    const items = [];
    for (const asset of assets) {
      items.push(await im.create(asset.meta, asset.payload));
    }
    await im.transaction(items);
  }

  /** A vault collection, fetched the way each sync run starts by doing. */
  vaultCollection(kind) {
    return this.cm.fetch(this.vault[kind].uid);
  }

  // ---------- sync::collab_room::note_room_info ----------

  /**
   * What opening a personal note costs before the relay can be dialled: the
   * per-note key lives only on the server, so it is fetched on every open.
   * Returns what the room derivation needs.
   */
  async roomInfo(noteUid) {
    const collection = await this.cm.fetch(this.vault.notes.uid);
    const item = await this.cm.getItemManager(collection).fetch(noteUid);
    const payload = decodePayload(await item.getContent());
    return { noteUid, noteKey: payload.crypto_key, salt: null, epoch: 0 };
  }

  /**
   * The same for a note in a shared folder. On top of the key fetch, the
   * writer-key registry has to be read out of the scope's assets collection:
   * `publish_collab_writer_key` and `note_room_info` each list that whole
   * collection from the start, and the member list is fetched to filter it.
   */
  async sharedRoomInfo(scopeId, noteUid, writerPublicKeyB64) {
    // share_scope_collab_info
    const list = await this.cm.list(COLLECTION_TYPE_SHARE_MANIFEST);
    let manifest = null;
    for (const manifestCollection of list.data) {
      if (manifestCollection.isDeleted) continue;
      const candidate = await manifestOf(manifestCollection);
      if (candidate.share_scope_id === scopeId) manifest = candidate;
    }
    if (!manifest) throw new Error(`no manifest for scope ${scopeId}`);

    const notesCollection = await this.cm.fetch(partUid(manifest, 'notes'));
    const item = await this.cm.getItemManager(notesCollection).fetch(noteUid);
    const payload = decodePayload(await item.getContent());

    const assetsCollection = await this.cm.fetch(partUid(manifest, 'assets'));
    const assetsIm = this.cm.getItemManager(assetsCollection);

    // publish_collab_writer_key
    const published = await this.listWriterKeys(assetsIm, scopeId);
    const username = this.account.user.username;
    const mine = (key) =>
      key.username === username && key.public_key_b64 === writerPublicKeyB64;
    if (!published.some(mine)) {
      const keyItem = await assetsIm.create(
        {
          type: ITEM_TYPE_COLLAB_WRITER_KEY,
          name: `collab-writer-key:${writerPublicKeyB64.slice(0, 12)}`,
          mtime: Date.now()
        },
        JSON.stringify({
          schema: 1,
          share_scope_id: scopeId,
          collab_epoch: manifest.collab_epoch,
          public_key_b64: writerPublicKeyB64,
          username
        })
      );
      await assetsIm.transaction([keyItem]);
    }

    // writable_member_usernames
    const members = this.cm.getMemberManager(assetsCollection);
    let iterator = null;
    for (;;) {
      const page = await members.list({ limit: 100, iterator });
      if (page.done) break;
      iterator = page.iterator;
    }

    await this.listWriterKeys(assetsIm, scopeId); // list_collab_writer_keys
    return {
      noteUid,
      noteKey: payload.crypto_key,
      salt: Buffer.from(manifest.collab_salt),
      epoch: manifest.collab_epoch
    };
  }

  /** `list_collab_writer_keys`: scan the collection for writer-key items. */
  async listWriterKeys(im, scopeId) {
    const keys = [];
    let stoken = null;
    for (;;) {
      const page = await im.list({ stoken });
      for (const item of page.data) {
        if (item.isDeleted || item.isMissingContent) continue;
        if (item.getMeta().type !== ITEM_TYPE_COLLAB_WRITER_KEY) continue;
        const key = JSON.parse(
          await item.getContent(Etebase.OutputFormat.String)
        );
        if (key.share_scope_id === scopeId) keys.push(key);
      }
      stoken = page.stoken ?? stoken;
      if (page.done) return keys;
    }
  }

  // ---------- setup (never timed) ----------

  /**
   * Build a shared folder the way `sharing` lays one out: a manifest
   * collection naming three part collections. Seeds one note and
   * `assetCount` attachments, since the writer-key scan above reads the
   * assets collection and its cost follows what is stored there.
   */
  async createShareScope({ note, assetCount, assetBytes }) {
    const scopeId = randomUUID();
    const refs = [];
    for (const part of SCOPE_PARTS) {
      const collection = await this.cm.create(
        COLLECTION_TYPES[part],
        { name: `Bench shared ${part}`, mtime: Date.now() },
        ''
      );
      await this.cm.upload(collection);
      refs.push({ part, collection_uid: collection.uid, required: true });
    }
    const manifest = {
      schema: 1,
      share_scope_id: scopeId,
      name: 'Bench shared folder',
      root_folder_id: randomUUID(),
      owner_username: this.account.user.username,
      collab_epoch: 1,
      collab_salt: [...randomBytes(32)],
      collections: refs
    };
    const manifestCollection = await this.cm.create(
      COLLECTION_TYPE_SHARE_MANIFEST,
      { name: manifest.name, mtime: Date.now() },
      JSON.stringify(manifest)
    );
    await this.cm.upload(manifestCollection);

    const notesCollection = await this.cm.fetch(partUid(manifest, 'notes'));
    await this.pushNotes(notesCollection, { newNotes: [note] });
    if (assetCount > 0) {
      await this.pushAssets(
        await this.cm.fetch(partUid(manifest, 'assets')),
        Array.from({ length: assetCount }, () => makeAsset(assetBytes))
      );
    }
    return scopeId;
  }

  async logout() {
    await this.account.logout();
  }
}
