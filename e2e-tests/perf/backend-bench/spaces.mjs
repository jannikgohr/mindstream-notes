/**
 * A "device" on the current data layout: one collection for the vault, one
 * for each shared folder.
 *
 * [vault.mjs](vault.mjs) replays what the app did against the stack it grew
 * up on: four vault collections, and a shared folder made of a manifest and
 * three part collections. This file replays what the app does now. The two
 * classes have the same methods, so a scenario in run.mjs reads the same
 * for both, and the difference between two runs is the difference the
 * layout and the server make together.
 *
 * As there, each method names the Rust function it mirrors and issues the
 * same requests in the same order. When the Rust side changes how it talks
 * to the server, change it here too or the numbers stop describing the app.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { meteredGet, meteredRequest } from './meter.mjs';
import {
  decodePayload,
  ITEM_TYPE_ASSET,
  ITEM_TYPE_NOTE,
  makeAsset
} from './workload.mjs';

const require = createRequire(import.meta.url);
const Etebase = require('etebase');

const COLLECTION_TYPE_VAULT = 'mindstream.vault';
const COLLECTION_TYPE_SHARED = 'mindstream.shared';

/** `HEADER_PAGE` in sync/pull.rs: how many items a listing without content asks for. */
const HEADER_PAGE = 500;

/**
 * `ItemKind::IN_ORDER` and `ItemKind::batch` in sync/pull.rs: the order the
 * kinds are applied in, and how many of each are fetched with content at a
 * time.
 */
const KINDS = [
  { type: 'ms-md-folder', batch: 200 },
  { type: ITEM_TYPE_NOTE, batch: 50 },
  { type: ITEM_TYPE_ASSET, batch: 5 },
  { type: 'ms-md-signature', batch: 20 }
];

function manifestOf(collection) {
  return collection
    .getContent(Etebase.OutputFormat.String)
    .then((json) => JSON.parse(json));
}

export class SpaceDevice {
  /** @param account A signed-in `Etebase.Account`. */
  constructor(serverUrl, account) {
    this.serverUrl = serverUrl;
    this.account = account;
    this.cm = account.getCollectionManager();
    /**
     * `{ uid, stoken }` of the vault, as the app keeps it in `sync_state`.
     * The vault has one cursor. `vault.notes` and `vault.assets` name that
     * same cursor, so a scenario written for the layout with a collection
     * per kind rewinds and pulls the right thing here.
     */
    this.cursor = null;
    /** scope (the shared collection's uid) → `{ uid, stoken }`. */
    this.scopes = new Map();
    /**
     * The account's cursor: what the list a sync opens with is asked
     * against. Null until a sync has applied everything, as in the app
     * after it starts.
     */
    this.accountStoken = null;
    /** Whether a sync has reached the server, see `preflight_reachable`. */
    this.reached = false;
    /** Item uid → the note's key, as `sync::room_keys` keeps them. */
    this.roomKeys = new Map();
  }

  get vault() {
    const cursor = this.cursor;
    return { folders: cursor, notes: cursor, assets: cursor };
  }

  /** A second device on the same account: same session, none of the cursors. */
  async secondDevice() {
    const restored = await Etebase.Account.restore(await this.account.save());
    return new SpaceDevice(this.serverUrl, restored);
  }

  // ---------- sync::run ----------

  /**
   * One sync, as `sync::run` behind the scheduler tick or `sync_now`.
   *
   * The quick reachability probe goes first only while the device does not
   * know that the server is there, which here is before its first sync.
   * Then one list says which spaces changed. The vault is visited when it
   * did or when there is something to send to it, a shared folder when it
   * did. A visit is a pull, then the push. A sync that visits nothing is
   * the list and no more.
   */
  async sync({ newNotes = [], editedNotes = [] } = {}) {
    if (!this.reached) {
      await meteredGet(`${this.serverUrl}/healthz`); // preflight_reachable
      this.reached = true;
    }
    const changes = await this.accountChanges();

    // `open_vault`
    const localWork = newNotes.length + editedNotes.length > 0;
    let collection = null;
    if (changes.full || !this.cursor || changes.vault.length > 0 || localWork) {
      collection = await this.ensureCollection(changes.vault);
      await this.pull(this.cursor, collection);
    }
    await this.pullScopes(changes);
    if (collection) {
      await this.pushNotes(collection, { newNotes, editedNotes });
    }
    // The cursor moves once everything the list named has been applied.
    // What this sync pushed is past it, so the next sync pulls that back.
    this.accountStoken = changes.stoken;
  }

  /**
   * `account_changes`: the collections of both types that changed since
   * the account's cursor, in one list.
   */
  async accountChanges() {
    const changes = {
      full: this.accountStoken === null,
      vault: [],
      shared: [],
      stoken: this.accountStoken
    };
    let stoken = this.accountStoken;
    for (;;) {
      const page = await this.cm.list(
        [COLLECTION_TYPE_VAULT, COLLECTION_TYPE_SHARED],
        { limit: 100, stoken }
      );
      for (const collection of page.data) {
        const type = collection.getCollectionType();
        if (type === COLLECTION_TYPE_VAULT) changes.vault.push(collection);
        else if (type === COLLECTION_TYPE_SHARED)
          changes.shared.push(collection);
      }
      stoken = page.stoken ?? stoken;
      if (page.done) break;
    }
    changes.stoken = stoken;
    return changes;
  }

  /**
   * `ensure_collection`: the cached vault collection, taken from the list
   * the sync opened with when it is in it and fetched otherwise. On a first
   * sync, list by type and adopt the smallest uid, or create one.
   */
  async ensureCollection(listed = []) {
    if (this.cursor) {
      return (
        listed.find((collection) => collection.uid === this.cursor.uid) ??
        this.cm.fetch(this.cursor.uid)
      );
    }

    const list = await this.cm.list(COLLECTION_TYPE_VAULT);
    const winner = list.data
      .filter((col) => !col.isDeleted)
      .map((col) => col.uid)
      .sort()[0];
    if (winner) {
      this.cursor = { uid: winner, stoken: null };
      return this.cm.fetch(winner);
    }
    const created = await this.cm.create(
      COLLECTION_TYPE_VAULT,
      { name: 'Mindstream Notes', mtime: Date.now() },
      ''
    );
    await this.cm.upload(created);
    this.cursor = { uid: created.uid, stoken: null };
    return created;
  }

  /**
   * `pull_space_once`: a change that fits one page is applied from that
   * page. A first pull, or more than a page, is listed without content and
   * then fetched kind by kind. Returns how many items arrived.
   */
  async pull(cursor, collection) {
    const im = this.cm.getItemManager(collection);
    if (cursor.stoken === null) return this.pullInBatches(im, cursor);

    const page = await im.list({ stoken: cursor.stoken });
    if (!page.done) return this.pullInBatches(im, cursor);
    for (const item of page.data) {
      if (item.isDeleted) continue;
      // The one item of a page that no page has room for.
      if (item.isMissingContent) await im.downloadContent(item);
      await item.getContent();
    }
    cursor.stoken = page.stoken ?? cursor.stoken;
    return page.data.length;
  }

  /** `pull_in_batches`, with `apply_fetched` for what the server holds back. */
  async pullInBatches(im, cursor) {
    const wanted = new Map(KINDS.map((kind) => [kind.type, []]));
    let stoken = cursor.stoken;
    let pulled = 0;
    for (;;) {
      const page = await im.list({
        stoken,
        // `PrefetchOption.Medium`, which the SDK does not export by name.
        prefetch: 'medium',
        limit: HEADER_PAGE
      });
      for (const item of page.data) {
        pulled += 1;
        if (item.isDeleted) continue;
        wanted.get(item.getMeta().type)?.push(item.uid);
      }
      stoken = page.stoken ?? stoken;
      if (page.done) break;
    }

    for (const kind of KINDS) {
      const uids = wanted.get(kind.type);
      for (let at = 0; at < uids.length; at += kind.batch) {
        let asking = uids.slice(at, at + kind.batch);
        while (asking.length > 0) {
          const fetched = await im.fetchMulti(asking);
          const again = [];
          for (const [place, item] of fetched.data.entries()) {
            if (item.isDeleted) continue;
            if (!item.isMissingContent) {
              await item.getContent();
            } else if (place === 0) {
              await im.downloadContent(item);
              await item.getContent();
            } else {
              again.push(item.uid);
            }
          }
          asking = again;
        }
      }
    }
    cursor.stoken = stoken;
    return pulled;
  }

  /**
   * `pull_scopes` + `pull_one_scope`: pull each shared folder the list
   * named from its cursor. The list comes with each collection's manifest,
   * and it is also what tells the device which shares it has lost, so
   * nothing more is asked for either. The scenarios never leave something
   * to send in a shared folder the server did not also change, so the
   * fetch of such a folder is not replayed here.
   */
  async pullScopes(changes) {
    for (const collection of changes.shared) {
      if (collection.isDeleted) continue;
      await manifestOf(collection);
      let cursor = this.scopes.get(collection.uid);
      if (!cursor) {
        cursor = { uid: collection.uid, stoken: null };
        this.scopes.set(collection.uid, cursor);
      }
      await this.pull(cursor, collection);
    }
  }

  /**
   * `push_notes`: every dirty row goes into one transaction. The rows that
   * already exist on the server are fetched first, a batch per request and
   * with their content, to carry each note's key over. `fetch_existing`
   * asks again for what one answer had no room for.
   */
  async pushNotes(collection, { newNotes = [], editedNotes = [] }) {
    const im = this.cm.getItemManager(collection);
    const items = [];
    const keys = [];
    const noteBatch = KINDS.find((kind) => kind.type === ITEM_TYPE_NOTE).batch;
    for (let at = 0; at < editedNotes.length; at += noteBatch) {
      const batch = editedNotes.slice(at, at + noteBatch);
      const existing = new Map();
      let asking = batch.map((note) => note.uid);
      while (asking.length > 0) {
        const fetched = await im.fetchMulti(asking);
        const again = [];
        for (const [place, item] of fetched.data.entries()) {
          if (item.isMissingContent && !item.isDeleted) {
            if (place > 0) {
              again.push(item.uid);
              continue;
            }
            await im.downloadContent(item);
          }
          existing.set(item.uid, item);
        }
        asking = again;
      }
      for (const note of batch) {
        const item = existing.get(note.uid);
        const { crypto_key: cryptoKey } = decodePayload(
          await item.getContent()
        );
        item.setMeta(note.meta());
        await item.setContent(note.payload(cryptoKey));
        items.push(item);
        keys.push(cryptoKey);
      }
    }
    for (const note of newNotes) {
      const cryptoKey = randomBytes(32);
      items.push(await im.create(note.meta(), note.payload(cryptoKey)));
      keys.push(cryptoKey);
    }
    if (items.length === 0) return;
    await im.transaction(items);
    newNotes.forEach((note, i) => {
      note.uid = items[editedNotes.length + i].uid;
    });
    // `room_keys`: the key each note went up with is kept on the device,
    // so that opening the note later does not fetch it to read the key.
    items.forEach((item, i) => this.roomKeys.set(item.uid, keys[i]));
  }

  /** `push_assets` for new assets: one transaction, blobs inline. */
  async pushAssets(collection, assets) {
    const im = this.cm.getItemManager(collection);
    const items = [];
    for (const asset of assets) {
      items.push(await im.create(asset.meta, asset.payload));
    }
    await im.transaction(items);
  }

  /** The vault collection, fetched the way each sync run starts by doing. */
  vaultCollection() {
    return this.cm.fetch(this.cursor.uid);
  }

  // ---------- sync::collab_room::note_room_info ----------

  /**
   * What opening a note costs before its room can be entered: the per-note
   * key lives only on the server, so the note's item is fetched on every
   * open, and with it the collection it is in.
   */
  async roomInfo(noteUid) {
    return this.roomInfoIn(this.cursor.uid, noteUid);
  }

  /**
   * The same for a note in a shared folder. The folder's collection is the
   * scope, so there is nothing to look up first, and the room's key comes
   * from the note alone, as it does in the vault.
   */
  async sharedRoomInfo(scope, noteUid) {
    return this.roomInfoIn(scope, noteUid);
  }

  async roomInfoIn(collectionUid, noteUid) {
    // The key a sync kept, when there is one. Then nothing is asked of the
    // server here, and the ticket is the only request of opening the note.
    let noteKey = this.roomKeys.get(noteUid);
    if (!noteKey) {
      const collection = await this.cm.fetch(collectionUid);
      const item = await this.cm.getItemManager(collection).fetch(noteUid);
      noteKey = decodePayload(await item.getContent()).crypto_key;
      this.roomKeys.set(noteUid, noteKey);
    }
    return {
      collectionUid,
      noteUid,
      noteKey,
      // The fields the key derivation shared with the old layout still
      // takes. The app as built has neither a salt nor an epoch.
      salt: null,
      epoch: 0
    };
  }

  /** Ask the server for a ticket to the room of one item. */
  async roomTicket(collectionUid, itemUid) {
    const { status, body } = await meteredRequest(
      `${this.serverUrl}/api/v1/collection/${collectionUid}/item/${itemUid}/room-ticket/`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${this.account.authToken}` }
      }
    );
    if (status !== 200) throw new Error(`room ticket refused with ${status}`);
    return decodePayload(body).ticket;
  }

  // ---------- setup (never timed) ----------

  /**
   * Build a shared folder the way `sharing` lays one out: one collection,
   * with the manifest as its own content. Seeds one note and `assetCount`
   * attachments, which is what made opening a note in a shared folder slow
   * on the old layout.
   */
  async createShareScope({ note, assetCount, assetBytes }) {
    const manifest = {
      schema: 3,
      root_folder_id: randomUUID(),
      owner_username: this.account.user.username
    };
    const collection = await this.cm.create(
      COLLECTION_TYPE_SHARED,
      { name: 'Bench shared folder', mtime: Date.now() },
      JSON.stringify(manifest)
    );
    await this.cm.upload(collection);
    await this.pushNotes(collection, { newNotes: [note] });
    if (assetCount > 0) {
      await this.pushAssets(
        collection,
        Array.from({ length: assetCount }, () => makeAsset(assetBytes))
      );
    }
    return collection.uid;
  }

  async logout() {
    await this.account.logout();
  }
}
