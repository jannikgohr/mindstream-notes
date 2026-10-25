import { afterEach, describe, expect, it, vi } from 'vitest';
import * as notes from './notes';
import { demoNoteId } from '$lib/onboarding/demo-note-id';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import {
  getOnboarding,
  parseOnboarding,
  restartOnboarding,
  saveOnboardingStep,
  finishOnboarding
} from './onboarding';

afterEach(() => {
  localStorage.removeItem('mindstream:onboarding:v1');
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe('browser onboarding', () => {
  it('stays out of normal development launches until requested', async () => {
    expect((await getOnboarding()).status).toBe('skipped');
    const started = await restartOnboarding();
    expect(started.status).toBe('inProgress');
    expect(started.freshInstall).toBe(false);
    expect((await restartOnboarding()).id).toBe(started.id);
  });

  it('resumes a saved step and keeps a skip decision across another launch', async () => {
    const started = await restartOnboarding();
    await saveOnboardingStep(started.id, 'appearance');
    expect((await getOnboarding()).step).toBe('appearance');
    await finishOnboarding(started.id, true, null);
    expect((await getOnboarding()).status).toBe('skipped');
    const restarted = await restartOnboarding();
    expect(restarted.id).not.toBe(started.id);
    await expect(saveOnboardingStep(started.id, 'editing')).rejects.toThrow(
      'session changed'
    );
  });

  it('rejects corrupt state instead of discarding the saved bytes', async () => {
    localStorage.setItem('mindstream:onboarding:v1', '{broken');
    await expect(getOnboarding()).rejects.toThrow();
    expect(localStorage.getItem('mindstream:onboarding:v1')).toBe('{broken');
    expect(() => parseOnboarding({ version: 99, id: 'bad' })).toThrow();
  });

  it('creates the requested initial note and completes without allowing stale writes', async () => {
    const started = await restartOnboarding();
    const before = await notes.listNotes();
    const initialNote = { title: 'First page', body: '# A new beginning' };
    const finished = await finishOnboarding(started.id, false, initialNote);
    expect(finished.progress.status).toBe('completed');
    expect(finished.noteId).toEqual(expect.any(String));
    expect(await notes.loadNote(finished.noteId!)).toMatchObject(initialNote);
    await expect(
      finishOnboarding(started.id, false, initialNote)
    ).rejects.toThrow('session changed');
    expect(await notes.listNotes()).toHaveLength(before.length + 1);
  });

  it('keeps native demo IDs and editor state, opens the first, and preserves edits on retry', async () => {
    const started = await restartOnboarding();
    const before = await notes.listNotes();
    const demo = (slug: string, title: string) => ({
      slug,
      lang: 'en',
      title,
      body: `# ${title}`,
      yrsState: [1, 2, 3]
    });
    const demos = [demo('basics', 'Basics'), demo('welcome', 'Welcome')];
    const finished = await finishOnboarding(started.id, false, null, demos);
    expect(finished.noteId).toBe(await demoNoteId(demos[0]));
    expect(await notes.loadNote(finished.noteId!)).toMatchObject({
      title: 'Basics',
      body: '# Basics',
      yrs_state: [1, 2, 3],
      payload_schema: 2
    });
    expect(await notes.listNotes()).toHaveLength(before.length + 2);
    await notes.saveNote({ id: finished.noteId!, title: 'Renamed' });
    const restarted = await restartOnboarding();
    await finishOnboarding(restarted.id, false, null, demos);
    expect((await notes.loadNote(finished.noteId!)).title).toBe('Renamed');
    expect(await notes.listNotes()).toHaveLength(before.length + 2);
  });

  it('keeps progress resumable if initial-note creation fails', async () => {
    const started = await restartOnboarding();
    const failure = new Error('database is locked');
    vi.spyOn(notes, 'createNote').mockRejectedValueOnce(failure);
    await expect(
      finishOnboarding(started.id, false, { title: 'First page', body: '' })
    ).rejects.toBe(failure);
    expect(await getOnboarding()).toEqual(started);
    expect(await finishOnboarding(started.id, false, null)).toEqual({
      progress: { ...started, status: 'completed' },
      noteId: null
    });
  });
});

describe('native onboarding bridge', () => {
  const progress = {
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'inProgress',
    step: 'account',
    vaultId: 'default',
    freshInstall: true
  };
  function native() {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  }

  it('routes progress reads, restarts, and step changes to native IPC', async () => {
    native();
    invoke.mockResolvedValue(progress);
    expect(await getOnboarding()).toEqual(progress);
    expect(await restartOnboarding()).toEqual(progress);
    invoke.mockResolvedValue({ ...progress, step: 'editing' });
    expect((await saveOnboardingStep(progress.id, 'editing')).step).toBe(
      'editing'
    );
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_onboarding', undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, 'restart_onboarding', undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, 'save_onboarding_step', {
      id: progress.id,
      step: 'editing'
    });
    expect(localStorage.getItem('mindstream:onboarding:v1')).toBeNull();
  });

  it.each([null, 'first-note'])(
    'validates a completed response with note ID %s',
    async (noteId) => {
      native();
      const completed = { ...progress, status: 'completed' };
      invoke.mockResolvedValue({ progress: completed, noteId });
      const initialNote = { title: 'Hello', body: 'My notes' };
      expect(await finishOnboarding(progress.id, false, initialNote)).toEqual({
        progress: completed,
        noteId
      });
      expect(invoke).toHaveBeenCalledWith('finish_onboarding', {
        id: progress.id,
        skipped: false,
        initialNote,
        demoNotes: []
      });
    }
  );

  it.each([
    { progress, noteId: 42 },
    { progress: { ...progress, step: 'unknown' }, noteId: null },
    { noteId: null },
    null
  ])('rejects an invalid completion response: %j', async (response) => {
    native();
    invoke.mockResolvedValue(response);
    await expect(finishOnboarding(progress.id, false, null)).rejects.toThrow();
  });

  it.each([
    { version: 2 },
    { id: 'not-a-uuid' },
    { status: 'unknown' },
    { step: 'unknown' },
    { vaultId: 42 },
    { freshInstall: 'true' }
  ])('rejects invalid saved/native progress: %j', (invalid) => {
    expect(() => parseOnboarding({ ...progress, ...invalid })).toThrow();
  });
});
