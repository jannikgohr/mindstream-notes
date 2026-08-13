import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfSignatureSnapshot } from '$lib/pdf/types';
import * as mod from './signatures.svelte';

const {
  loadReusableSignatures,
  saveReusableSignature,
  deleteReusableSignature,
  isTauri,
  emit,
  listen
} = vi.hoisted(() => ({
  loadReusableSignatures: vi.fn(),
  saveReusableSignature: vi.fn(),
  deleteReusableSignature: vi.fn(),
  isTauri: vi.fn(() => true),
  emit: vi.fn(),
  listen: vi.fn()
}));

vi.mock('$lib/pdf/signature-storage', () => ({
  loadReusableSignatures,
  saveReusableSignature,
  deleteReusableSignature
}));
vi.mock('$lib/api', () => ({ isTauri }));
vi.mock('$lib/api/events', () => ({
  emit,
  listen,
  TauriEventName: { SignaturesChanged: 'signatures-changed' }
}));

const sig = (id: string): PdfSignatureSnapshot => ({
  id,
  width: 10,
  height: 10,
  strokes: [{ id: 's', color: '#000', width: 1, points: [] }]
});

beforeEach(() => {
  mod.signatureLibrary.signatures = [];
  mod.signatureLibrary.loaded = false;
  loadReusableSignatures.mockReset().mockResolvedValue([sig('a')]);
  saveReusableSignature.mockReset().mockResolvedValue(undefined);
  deleteReusableSignature.mockReset().mockResolvedValue(undefined);
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

describe('Tauri cross-window wiring + persistence errors', () => {
  it('wires a cross-window listener and re-reads on the event', async () => {
    await mod.ensureSignaturesLoaded();
    expect(listen).toHaveBeenCalledWith(
      'signatures-changed',
      expect.any(Function)
    );
    // Firing the listener callback re-reads the store.
    loadReusableSignatures.mockResolvedValueOnce([sig('z')]);
    const cb = listen.mock.calls[0][1] as () => void;
    cb();
    await Promise.resolve();
    await Promise.resolve();
    expect(mod.signatureLibrary.signatures.map((s) => s.id)).toEqual(['z']);
  });

  it('broadcasts a change after a successful add', async () => {
    await mod.addSignature(sig('new'));
    expect(emit).toHaveBeenCalledWith('signatures-changed', null);
  });

  it('swallows refresh/add/remove persistence failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadReusableSignatures.mockRejectedValueOnce(new Error('r'));
    await expect(mod.refreshSignatures()).resolves.toBeUndefined();
    saveReusableSignature.mockRejectedValueOnce(new Error('s'));
    await expect(mod.addSignature(sig('n2'))).resolves.toBeUndefined();
    deleteReusableSignature.mockRejectedValueOnce(new Error('d'));
    await expect(mod.removeSignature('n2')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
