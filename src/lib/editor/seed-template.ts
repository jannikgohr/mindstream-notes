/**
 * Deterministic "seed a note's Yjs doc from its markdown body" — a
 * merge-safe replacement for `CollabService.applyTemplate` for the
 * first-open, empty-fragment case.
 *
 * Milkdown's `applyTemplate` converts the markdown to a ProseMirror node and
 * then `prosemirrorToYDoc(node)` — which mints a brand-new `Y.Doc` with a
 * *random* client id — before applying that update into the live doc. That's
 * fine for a note that only ever exists on one device. But seeded/demo notes
 * (deterministic ids like `seed_welcome`) are created independently on every
 * fresh device, so each device would tag its "insert the seed body" ops with
 * a different client id. A CRDT merge then keeps BOTH origins and the body
 * duplicates ("WelcomeWelcome…"), compounding across sync rounds.
 *
 * Building the template doc with a FIXED client id makes every device produce
 * byte-identical origin bytes, so the merge collapses them to one. Live edits
 * are unaffected: they run on the live doc, which keeps its own (random)
 * client id — only the shared origin baseline is pinned.
 */

import { getDoc, parserCtx, schemaCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

/** The prosemirror fragment name y-prosemirror + Crepe bind to. */
const FRAGMENT = 'prosemirror';

/**
 * Client id every note's from-markdown origin op is stamped with. Any fixed
 * value works; the only requirement is that it's the SAME on every device so
 * the seeded baseline is one shared operation. Live edits use the live doc's
 * own random client id, so a stray collision with this constant would at
 * worst affect a single note's own history — never cross-note — and is a
 * 1-in-2^32 event regardless. Mirrors the intent of
 * src-tauri/src/sync/yrs_doc.rs::SEED_ORIGIN_CLIENT_ID (a separate v1 path).
 */
export const TEMPLATE_ORIGIN_CLIENT_ID = 0x5eed;

/**
 * Seed `liveDoc`'s prosemirror fragment from `markdown` with a deterministic
 * origin. Call only when the fragment is empty (the first-open path); it does
 * not clear existing content. No-op when the markdown parses to nothing.
 */
export function seedDeterministicTemplate(
  ctx: Ctx,
  liveDoc: Y.Doc,
  markdown: string
): void {
  const schema = ctx.get(schemaCtx);
  const node = getDoc(markdown, ctx.get(parserCtx), schema);
  if (!node) return;

  // Throwaway doc pinned to the shared origin client id — same pattern
  // Milkdown's applyTemplate uses (prosemirrorToYDoc → encode → apply),
  // but with a fixed client id instead of a random one.
  const templateDoc = new Y.Doc();
  templateDoc.clientID = TEMPLATE_ORIGIN_CLIENT_ID;
  prosemirrorToYXmlFragment(node, templateDoc.getXmlFragment(FRAGMENT));
  Y.applyUpdate(liveDoc, Y.encodeStateAsUpdate(templateDoc));
  templateDoc.destroy();
}
