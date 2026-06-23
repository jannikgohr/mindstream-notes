import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfSignatureSnapshot } from '$lib/pdf/types';

const {
  loadReusableSignatures,
  saveReusableSignature,
  deleteReusableSignature
} = vi.hoisted(() => ({
  loadReusableSignatures: vi.fn(),
  saveReusableSignature: vi.fn(),
  deleteReusableSignature: vi.fn()
}));

vi.mock('$lib/pdf/signature-storage', () => ({
  loadReusableSignatures,
  saveReusableSignature,
  deleteReusableSignature
}));

type Mod = typeof import('./signatures.svelte');
let mod: Mod;

const sig = (id: string): PdfSignatureSnapshot => ({
  id,
  width: 10,
  height: 10,
  strokes: [{ id: 's', color: '#000', width: 1, points: [] }]
});

beforeEach(async () => {
  vi.resetModules();
  loadReusableSignatures.mockReset().mockResolvedValue([sig('a')]);
  saveReusableSignature.mockReset().mockResolvedValue(undefined);
  deleteReusableSignature.mockReset().mockResolvedValue(undefined);
  mod = await import('./signatures.svelte');
});

describe('ensureSignaturesLoaded', () => {
  it('loads the library once and marks it loaded', async () => {
    await mod.ensureSignaturesLoaded();
    expect(mod.signatureLibrary.loaded).toBe(true);
    expect(mod.signatureLibrary.signatures.map((s) => s.id)).toEqual(['a']);
    expect(loadReusableSignatures).toHaveBeenCalledOnce();
  });

  it('does not re-read once loaded', async () => {
    await mod.ensureSignaturesLoaded();
    await mod.ensureSignaturesLoaded();
    expect(loadReusableSignatures).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent first loads', async () => {
    await Promise.all([
      mod.ensureSignaturesLoaded(),
      mod.ensureSignaturesLoaded()
    ]);
    expect(loadReusableSignatures).toHaveBeenCalledOnce();
  });

  it('swallows a load failure without marking loaded', async () => {
    loadReusableSignatures.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mod.ensureSignaturesLoaded();
    expect(mod.signatureLibrary.loaded).toBe(false);
    warn.mockRestore();
  });
});

describe('refreshSignatures', () => {
  it('re-reads the backing store', async () => {
    loadReusableSignatures.mockResolvedValueOnce([sig('x'), sig('y')]);
    await mod.refreshSignatures();
    expect(mod.signatureLibrary.signatures.map((s) => s.id)).toEqual([
      'x',
      'y'
    ]);
    expect(mod.signatureLibrary.loaded).toBe(true);
  });
});

describe('addSignature', () => {
  it('optimistically appends and persists', async () => {
    await mod.addSignature(sig('new'));
    expect(mod.signatureLibrary.signatures.map((s) => s.id)).toContain('new');
    expect(saveReusableSignature).toHaveBeenCalledOnce();
  });
});

describe('removeSignature', () => {
  it('optimistically removes and persists the deletion', async () => {
    await mod.refreshSignatures(); // seeds [a]
    await mod.removeSignature('a');
    expect(mod.signatureLibrary.signatures.map((s) => s.id)).not.toContain('a');
    expect(deleteReusableSignature).toHaveBeenCalledWith('a');
  });
});
