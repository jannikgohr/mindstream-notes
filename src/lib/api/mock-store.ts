/**
 * In-memory fallback used when the frontend runs outside Tauri
 * (`pnpm dev` in a normal browser). Same shape as the Rust commands so
 * components can't tell the difference.
 *
 * Seeded once at module load with the same demo content Rust inserts on
 * first run so the look-and-feel matches between dev and tauri dev.
 */

import type {
  Collection,
  CreateCollectionInput,
  UpdateCollectionInput
} from './collections';
import type {
  CreateNoteInput,
  Note,
  NoteSummary,
  UpdateNoteInput
} from './notes';
import type { Asset, UploadAssetInput } from './assets';
import type { ImportPdfNoteInput } from './assets';
import type { SearchHit } from './search';
import type { SaveSignatureInput, SignatureRecord } from './signatures';
import { mockSearchNotes } from './search-matcher';

const collections: Collection[] = [];
const notes = new Map<string, Note>();
const assets = new Map<string, Asset>();

function nowIso(): string {
  return new Date().toISOString();
}

function randId(prefix: 'note' | 'coll' | 'asset'): string {
  return `${prefix}_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function summary(n: Note): NoteSummary {
  // Strip body for list calls.
  const { body: _body, ...s } = n;
  return s;
}

function maxPosition(arr: { position: number }[]): number {
  return arr.reduce((m, x) => Math.max(m, x.position), -1);
}

(function seed() {
  const t = nowIso();
  const work: Collection = {
    id: 'coll_seed_work',
    parent_collection_id: null,
    name: 'Work',
    position: 0,
    created: t,
    modified: t
  };
  const personal: Collection = {
    id: 'coll_seed_personal',
    parent_collection_id: null,
    name: 'Personal',
    position: 1,
    created: t,
    modified: t
  };
  const trash: Collection = {
    id: 'trash',
    parent_collection_id: null,
    name: 'Trash',
    position: 9999999,
    created: t,
    modified: t
  };
  collections.push(work, personal, trash);

  const welcome: Note = {
    id: 'note_seed_welcome',
    parent_collection_id: null,
    title: 'Welcome',
    body: '# Welcome\n\nYou are running in browser fallback mode (no Tauri). Open the desktop app for full persistence.\n',
    position: 0,
    created: t,
    modified: t,
    tags: [],
    trashed: false,
    favourite: false,
    pushed: false,
    note_kind: 'markdown',
    yrs_state: [],
    payload_schema: 1
  };
  const meeting: Note = {
    id: 'note_seed_meeting',
    parent_collection_id: work.id,
    title: 'Sprint planning',
    body: '# Sprint planning\n\n## Agenda\n\n1. Carry-over from last sprint\n2. Capacity check\n3. Commit\n',
    position: 0,
    created: t,
    modified: t,
    tags: [],
    trashed: false,
    favourite: false,
    pushed: false,
    note_kind: 'markdown',
    yrs_state: [],
    payload_schema: 1
  };
  const ideas: Note = {
    id: 'note_seed_ideas',
    parent_collection_id: personal.id,
    title: 'Ideas',
    body: '# Ideas\n\n- Try a graph view\n- Backlinks panel\n- Daily notes\n',
    position: 0,
    created: t,
    modified: t,
    tags: [],
    trashed: false,
    favourite: false,
    pushed: false,
    note_kind: 'markdown',
    yrs_state: [],
    payload_schema: 1
  };
  notes.set(welcome.id, welcome);
  notes.set(meeting.id, meeting);
  notes.set(ideas.id, ideas);
})();

export const mockApi = {
  // ---- Collections ----
  async listCollections(): Promise<Collection[]> {
    return [...collections];
  },
  async createCollection(input: CreateCollectionInput): Promise<Collection> {
    const t = nowIso();
    const siblings = collections.filter(
      (c) => c.parent_collection_id === (input.parent_collection_id ?? null)
    );
    const c: Collection = {
      id: randId('coll'),
      parent_collection_id: input.parent_collection_id ?? null,
      name: input.name,
      position: maxPosition(siblings) + 1,
      created: t,
      modified: t
    };
    collections.push(c);
    return c;
  },
  async updateCollection(input: UpdateCollectionInput): Promise<Collection> {
    const c = collections.find((x) => x.id === input.id);
    if (!c) throw new Error(`collection ${input.id} not found`);
    if (input.name !== undefined) c.name = input.name;
    if (input.parent_collection_id !== undefined)
      c.parent_collection_id = input.parent_collection_id;
    if (input.position !== undefined) c.position = input.position;
    c.modified = nowIso();
    return { ...c };
  },
  async deleteCollection(id: string): Promise<void> {
    const idx = collections.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`collection ${id} not found`);
    collections.splice(idx, 1);
    for (const c of [...collections]) {
      if (c.parent_collection_id === id) {
        await this.deleteCollection(c.id);
      }
    }
    for (const n of notes.values()) {
      if (n.parent_collection_id === id) {
        n.trashed = true;
        n.modified = nowIso();
      }
    }
  },

  // ---- Notes ----
  async listNotes(includeTrashed: boolean): Promise<NoteSummary[]> {
    const arr = [...notes.values()].filter((n) => includeTrashed || !n.trashed);
    return arr.map(summary);
  },
  async loadNote(id: string): Promise<Note> {
    const n = notes.get(id);
    if (!n) throw new Error(`note ${id} not found`);
    return { ...n };
  },
  async createNote(input: CreateNoteInput): Promise<Note> {
    const t = nowIso();
    const siblings = [...notes.values()].filter(
      (n) => n.parent_collection_id === (input.parent_collection_id ?? null)
    );
    const n: Note = {
      id: randId('note'),
      parent_collection_id: input.parent_collection_id ?? null,
      title: input.title ?? 'Untitled',
      body: input.body ?? '',
      position: maxPosition(siblings) + 1,
      created: t,
      modified: t,
      tags: [],
      trashed: false,
      favourite: false,
      pushed: false,
      note_kind: input.note_kind ?? 'markdown',
      yrs_state: [],
      payload_schema: 1
    };
    notes.set(n.id, n);
    return { ...n };
  },
  async saveNote(input: UpdateNoteInput): Promise<Note> {
    const n = notes.get(input.id);
    if (!n) throw new Error(`note ${input.id} not found`);
    if (input.title !== undefined) n.title = input.title;
    if (input.body !== undefined) n.body = input.body;
    if (input.parent_collection_id !== undefined)
      n.parent_collection_id = input.parent_collection_id;
    if (input.position !== undefined) n.position = input.position;
    if (input.tags !== undefined) n.tags = [...input.tags];
    if (input.favourite !== undefined) n.favourite = input.favourite;
    n.modified = nowIso();
    return { ...n };
  },
  async trashNote(id: string): Promise<void> {
    const n = notes.get(id);
    if (!n) throw new Error(`note ${id} not found`);
    n.trashed = true;
    n.modified = nowIso();
  },
  async restoreNote(id: string): Promise<void> {
    const n = notes.get(id);
    if (!n) throw new Error(`note ${id} not found`);
    n.trashed = false;
    n.modified = nowIso();
  },
  async purgeNote(id: string): Promise<void> {
    if (!notes.delete(id)) throw new Error(`note ${id} not found`);
    // Mimic the Rust ON DELETE CASCADE — clean up any assets owned by
    // the purged note so dev-mode fallback matches Tauri behaviour.
    for (const [aid, a] of assets) {
      if (a.owning_note_id === id) assets.delete(aid);
    }
  },

  async searchNotes(query: string): Promise<SearchHit[]> {
    const pool = [...notes.values()]
      .filter((n) => !n.trashed)
      .map((n) => ({
        ...n,
        // Strip body off the hit-emitted summary — the dialog reads
        // from the snippet field instead, matching the Rust shape.
        body: n.body,
        tags: n.tags
      }));
    const hits = mockSearchNotes(pool, query);
    // Drop body from each emitted note summary so the shape matches
    // Rust's NoteSummary (no body).
    return hits.map((h) => {
      const summary = { ...(h.note as unknown as Note) };
      const { body: _b, yrs_state: _y, payload_schema: _p, ...rest } = summary;
      return { ...h, note: rest as unknown as SearchHit['note'] };
    });
  },

  // ---- Drawing assets ----
  async uploadDrawingAsset(input: UploadAssetInput): Promise<Asset> {
    if (!notes.has(input.owning_note_id)) {
      throw new Error(`note ${input.owning_note_id} not found`);
    }
    const t = nowIso();
    const a: Asset = {
      id: randId('asset'),
      owning_note_id: input.owning_note_id,
      mime_type: input.mime_type,
      size: input.bytes.length,
      created: t,
      modified: t,
      pushed: false,
      bytes: input.bytes
    };
    assets.set(a.id, a);
    return { ...a };
  },
  async fetchDrawingAsset(id: string): Promise<Asset> {
    const a = assets.get(id);
    if (!a) throw new Error(`asset ${id} not found`);
    return { ...a };
  },
  async importPdfNote(input: ImportPdfNoteInput): Promise<Note> {
    const note = await this.createNote({
      title: input.title,
      parent_collection_id: input.parent_collection_id,
      note_kind: 'pdf'
    });
    const asset = await this.uploadDrawingAsset({
      owning_note_id: note.id,
      mime_type: 'application/pdf',
      bytes: input.bytes
    });
    note.body = JSON.stringify({ pdfAssetId: asset.id });
    notes.set(note.id, note);
    return { ...note };
  },
  async listSignatures(): Promise<SignatureRecord[]> {
    return loadMockSignatures();
  },
  async saveSignature(input: SaveSignatureInput): Promise<SignatureRecord> {
    const list = loadMockSignatures();
    const t = nowIso();
    const existing = list.find((s) => s.id === input.id);
    let rec: SignatureRecord;
    if (existing) {
      existing.data = input.data;
      existing.modified = t;
      rec = existing;
    } else {
      rec = {
        id: input.id,
        data: input.data,
        created: t,
        modified: t,
        pushed: false
      };
      list.push(rec);
    }
    saveMockSignatures(list);
    return { ...rec };
  },
  async deleteSignature(id: string): Promise<void> {
    saveMockSignatures(loadMockSignatures().filter((s) => s.id !== id));
  }
};

// Dev signatures persist in localStorage so the picker survives a reload,
// standing in for the synced SQLite table the Tauri build uses.
const MOCK_SIGNATURES_KEY = 'mindstream.mock.signatures.v1';
function loadMockSignatures(): SignatureRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(MOCK_SIGNATURES_KEY);
    const parsed = raw ? (JSON.parse(raw) as SignatureRecord[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveMockSignatures(list: SignatureRecord[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MOCK_SIGNATURES_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota / serialisation errors in the dev fallback */
  }
}
