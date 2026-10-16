import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignatureRecord } from '$lib/api/signatures';

const listSignatures = vi.fn();
const saveSignature = vi.fn();
const deleteSignature = vi.fn();
let native = false;
const migrateLegacyContent = vi.fn();

vi.mock('$lib/api/core', () => ({ isTauri: () => native }));
vi.mock('$lib/api/legacy-content', () => ({ migrateLegacyContent }));

vi.mock('$lib/api/signatures', () => ({
  listSignatures,
  saveSignature,
  deleteSignature
}));

type Mod = typeof import('./signature-storage');
let mod: Mod;

const ARRAY_KEY = 'mindstream.pdf.signatures.v1';
const SINGLE_KEY = 'mindstream.pdf.signature.v1';

const geom = (id?: string) => ({
  ...(id ? { id } : {}),
  width: 100,
  height: 40,
  strokes: [{ id: 's', color: '#000', width: 2, points: [{ x: 0, y: 0 }] }]
});

const record = (id: string): SignatureRecord => ({
  id,
  data: JSON.stringify(geom()),
  created: 't',
  modified: 't',
  pushed: false
});

beforeEach(async () => {
  vi.resetModules();
  native = false;
  migrateLegacyContent.mockReset().mockResolvedValue([]);
  localStorage.clear();
  listSignatures.mockReset().mockResolvedValue([]);
  saveSignature.mockReset().mockResolvedValue(undefined);
  deleteSignature.mockReset().mockResolvedValue(undefined);
  mod = await import('./signature-storage');
});

describe('readLegacySnapshots', () => {
  it('returns an empty list when there is nothing stored', () => {
    expect(mod.readLegacySnapshots()).toEqual([]);
  });

  it('reads the array key, skipping entries without strokes', () => {
    localStorage.setItem(
      ARRAY_KEY,
      JSON.stringify([geom('a'), { id: 'b', strokes: [] }])
    );
    const out = mod.readLegacySnapshots();
    expect(out.map((s) => s.id)).toEqual(['a']);
  });

  it('skips non-object and malformed legacy array entries', () => {
    localStorage.setItem(
      ARRAY_KEY,
      JSON.stringify([
        geom('a'),
        null,
        'bad',
        { id: 'flat', width: 1, height: 1, strokes: [] },
        { id: 'missing-size', strokes: [{ id: 's' }] }
      ])
    );

    const out = mod.readLegacySnapshots();

    expect(out.map((s) => s.id)).toEqual(['a']);
  });

  it('reads the single-signature key', () => {
    localStorage.setItem(SINGLE_KEY, JSON.stringify(geom('solo')));
    expect(mod.readLegacySnapshots().map((s) => s.id)).toEqual(['solo']);
  });

  it('ignores a malformed single-signature shape', () => {
    localStorage.setItem(
      SINGLE_KEY,
      JSON.stringify({ id: 'solo', width: 100, strokes: [{ id: 's' }] })
    );
    expect(mod.readLegacySnapshots()).toEqual([]);
  });

  it('fills in a missing id', () => {
    localStorage.setItem(ARRAY_KEY, JSON.stringify([geom()]));
    const out = mod.readLegacySnapshots();
    expect(out).toHaveLength(1);
    expect(typeof out[0].id).toBe('string');
    expect(out[0].id.length).toBeGreaterThan(0);
  });

  it('ignores malformed legacy JSON', () => {
    localStorage.setItem(ARRAY_KEY, '{not json');
    expect(mod.readLegacySnapshots()).toEqual([]);
  });
});

describe('loadReusableSignatures', () => {
  it('passes unchanged native sources to the transactional import and retains them', async () => {
    native = true;
    const array = JSON.stringify([geom('legacy')]);
    const single = JSON.stringify(geom());
    localStorage.setItem(ARRAY_KEY, array);
    localStorage.setItem(SINGLE_KEY, single);
    listSignatures.mockResolvedValue([record('imported')]);
    expect((await mod.loadReusableSignatures()).map((s) => s.id)).toEqual([
      'imported'
    ]);
    expect(migrateLegacyContent).toHaveBeenCalledWith(
      'signatures',
      array,
      single
    );
    expect(saveSignature).not.toHaveBeenCalled();
    expect(localStorage.getItem(ARRAY_KEY)).toBe(array);
    expect(localStorage.getItem(SINGLE_KEY)).toBe(single);
  });

  it('retains malformed native bytes after an import error and still loads the existing library', async () => {
    native = true;
    localStorage.setItem(ARRAY_KEY, 'malformed evidence');
    migrateLegacyContent.mockRejectedValueOnce(new Error('invalid source'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listSignatures.mockResolvedValue([record('existing')]);
    expect((await mod.loadReusableSignatures()).map((s) => s.id)).toEqual([
      'existing'
    ]);
    expect(migrateLegacyContent).toHaveBeenCalledWith(
      'signatures',
      'malformed evidence',
      null
    );
    expect(localStorage.getItem(ARRAY_KEY)).toBe('malformed evidence');
  });
  it('maps synced records into snapshots when there is no legacy data', async () => {
    listSignatures.mockResolvedValue([record('r1'), record('r2')]);
    const out = await mod.loadReusableSignatures();
    expect(out.map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(saveSignature).not.toHaveBeenCalled();
  });

  it('drops records whose data is unusable', async () => {
    listSignatures.mockResolvedValue([
      record('good'),
      { id: 'bad', data: 'broken', created: 't', modified: 't', pushed: false }
    ]);
    const out = await mod.loadReusableSignatures();
    expect(out.map((s) => s.id)).toEqual(['good']);
  });

  it('migrates legacy signatures once, then clears the old keys', async () => {
    localStorage.setItem(ARRAY_KEY, JSON.stringify([geom('legacy1')]));
    localStorage.setItem(SINGLE_KEY, JSON.stringify(geom('legacy2')));
    listSignatures.mockResolvedValue([]);

    await mod.loadReusableSignatures();

    expect(saveSignature).toHaveBeenCalledTimes(2);
    expect(saveSignature.mock.calls.map((c) => c[0].id).sort()).toEqual([
      'legacy1',
      'legacy2'
    ]);
    expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
    expect(localStorage.getItem(SINGLE_KEY)).toBeNull();
  });

  it('does not re-migrate on a second call', async () => {
    localStorage.setItem(ARRAY_KEY, JSON.stringify([geom('legacy1')]));
    await mod.loadReusableSignatures();
    saveSignature.mockClear();
    await mod.loadReusableSignatures();
    expect(saveSignature).not.toHaveBeenCalled();
  });
});

describe('save / delete', () => {
  it('saveReusableSignature serialises geometry without the id', async () => {
    await mod.saveReusableSignature({
      id: 'sig',
      width: 1,
      height: 1,
      strokes: [{ id: 's', color: '#000', width: 1, points: [] }]
    });
    expect(saveSignature).toHaveBeenCalledOnce();
    const arg = saveSignature.mock.calls[0][0];
    expect(arg.id).toBe('sig');
    expect(JSON.parse(arg.data)).not.toHaveProperty('id');
  });

  it('deleteReusableSignature forwards the id', async () => {
    await mod.deleteReusableSignature('sig');
    expect(deleteSignature).toHaveBeenCalledWith('sig');
  });
});
