import type {
  CreateNoteInput,
  Note,
  NoteSummary,
  UpdateNoteInput
} from '../api/notes';
import type {
  Collection,
  CreateCollectionInput,
  UpdateCollectionInput
} from '../api/collections';
import type { SearchHit } from '../api/search';
import type {
  Asset,
  UploadAssetInput,
  ImportPdfNoteInput,
  ImportInkPdfNoteInput
} from '../api/assets';
import type { Version, VersionAction, VersionSummary } from '../api/history';
import type { SaveSignatureInput, SignatureRecord } from '../api/signatures';
import type { BatchCounts, TreeItemRef } from '../api/tree-batch';
import type { DemoNote } from '../api/onboarding';

type Operation<A, R> = { args: A; result: R };
type Empty = Record<string, never>;
type Id = { id: string };
export interface BrowserCommands {
  load_tree: Operation<
    Empty,
    { collections: Collection[]; notes: NoteSummary[] }
  >;
  list_notes: Operation<{ includeTrashed?: boolean }, NoteSummary[]>;
  load_note: Operation<Id, Note>;
  create_note: Operation<{ input: CreateNoteInput }, Note>;
  save_note: Operation<{ input: UpdateNoteInput }, Note>;
  trash_note: Operation<Id, void>;
  restore_note: Operation<Id, void>;
  purge_note: Operation<Id, void>;
  list_collections: Operation<Empty, Collection[]>;
  create_collection: Operation<{ input: CreateCollectionInput }, Collection>;
  update_collection: Operation<{ input: UpdateCollectionInput }, Collection>;
  delete_collection: Operation<Id, void>;
  search_notes: Operation<{ query: string }, SearchHit[]>;
  note_word_count: Operation<{ noteId: string }, number>;
  move_many: Operation<
    { items: TreeItemRef[]; targetCollectionId: string | null },
    BatchCounts
  >;
  trash_many: Operation<{ items: TreeItemRef[] }, BatchCounts>;
  restore_many: Operation<{ items: TreeItemRef[] }, BatchCounts>;
  purge_many: Operation<{ items: TreeItemRef[] }, BatchCounts>;
  upload_drawing_asset: Operation<{ input: UploadAssetInput }, Asset>;
  fetch_drawing_asset: Operation<Id, Asset>;
  import_pdf_note: Operation<{ input: ImportPdfNoteInput }, Note>;
  import_ink_pdf_note: Operation<{ input: ImportInkPdfNoteInput }, Note>;
  sweep_unreferenced_markdown_assets: Operation<Empty, number>;
  capture_note_version: Operation<
    {
      noteId: string;
      noteKind: Note['note_kind'];
      action: VersionAction;
      refVersionId: string | null;
      markdown: string;
    },
    VersionSummary | null
  >;
  capture_current_note_version: Operation<
    { noteId: string; action: VersionAction; refVersionId: string | null },
    VersionSummary | null
  >;
  list_note_versions: Operation<{ noteId: string }, VersionSummary[]>;
  load_note_version: Operation<{ versionId: string }, Version>;
  prune_note_versions: Operation<{ retentionDays: number | null }, number>;
  list_signatures: Operation<Empty, SignatureRecord[]>;
  save_signature: Operation<{ input: SaveSignatureInput }, SignatureRecord>;
  delete_signature: Operation<Id, void>;
  insert_demo_notes: Operation<{ notes: DemoNote[] }, string[]>;
  trash_counts: Operation<Empty, BatchCounts>;
  empty_trash: Operation<Empty, BatchCounts>;
  pdf_notes_missing_text: Operation<Empty, string[]>;
  pdf_note_needs_text: Operation<{ noteId: string }, boolean>;
  set_pdf_text: Operation<
    { noteId: string; text: string; expectedSignature?: string },
    void
  >;
  pdf_page_text: Operation<
    { assetId: string; pageIndex: number; text?: string },
    string | null
  >;
}
export type BrowserCommand = keyof BrowserCommands;
export type BrowserRequest = {
  [K in BrowserCommand]: { command: K; args: BrowserCommands[K]['args'] };
}[BrowserCommand];
const commands = {
  load_tree: true,
  list_notes: true,
  load_note: true,
  create_note: true,
  save_note: true,
  trash_note: true,
  restore_note: true,
  purge_note: true,
  list_collections: true,
  create_collection: true,
  update_collection: true,
  delete_collection: true,
  search_notes: true,
  note_word_count: true,
  move_many: true,
  trash_many: true,
  restore_many: true,
  purge_many: true,
  upload_drawing_asset: true,
  fetch_drawing_asset: true,
  import_pdf_note: true,
  import_ink_pdf_note: true,
  sweep_unreferenced_markdown_assets: true,
  capture_note_version: true,
  capture_current_note_version: true,
  list_note_versions: true,
  load_note_version: true,
  prune_note_versions: true,
  list_signatures: true,
  save_signature: true,
  delete_signature: true,
  insert_demo_notes: true,
  trash_counts: true,
  empty_trash: true,
  pdf_notes_missing_text: true,
  pdf_note_needs_text: true,
  set_pdf_text: true,
  pdf_page_text: true
} satisfies Record<BrowserCommand, true>;
export function isBrowserCommand(command: unknown): command is BrowserCommand {
  return typeof command === 'string' && Object.hasOwn(commands, command);
}
export function browserStorageEnabled(): boolean {
  return (
    import.meta.env.MODE !== 'test' &&
    import.meta.env.VITE_BROWSER_MOCKS !== '1'
  );
}
