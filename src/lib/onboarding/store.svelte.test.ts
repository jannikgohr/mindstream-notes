import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingProgress } from '$lib/api/onboarding';
import { onAppSuspend } from '$lib/editor/suspend-flush';

const { restartOnboarding, closeSettings } = vi.hoisted(() => ({
  restartOnboarding: vi.fn(),
  closeSettings: vi.fn()
}));
vi.mock('$lib/api/onboarding', () => ({ restartOnboarding }));
vi.mock('$lib/settings/store.svelte', () => ({ closeSettings }));

import { onboarding, openOnboarding, takeOnboardingNote } from './store.svelte';

const previous: OnboardingProgress = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  status: 'completed',
  step: 'start',
  vaultId: 'default',
  freshInstall: false
};
const restarted: OnboardingProgress = {
  ...previous,
  id: '00000000-0000-4000-8000-000000000002',
  status: 'inProgress',
  step: 'account'
};
let stopSaving = () => {};

beforeEach(() => {
  vi.resetAllMocks();
  restartOnboarding.mockResolvedValue(restarted);
  onboarding.progress = previous;
  onboarding.initialNoteId = null;
  onboarding.finishing = false;
});
afterEach(() => {
  stopSaving();
  stopSaving = () => {};
  onboarding.progress = null;
  onboarding.initialNoteId = null;
  onboarding.finishing = false;
});

describe('opening setup from a workspace', () => {
  it('waits for mounted editors to save before restarting and closing settings', async () => {
    let saved!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const save = vi.fn(() => pendingSave);
    stopSaving = onAppSuspend(save);
    const opening = openOnboarding();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(restartOnboarding).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(onboarding.progress).toEqual(previous);
    saved();
    await opening;
    expect(restartOnboarding).toHaveBeenCalledOnce();
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(onboarding.progress).toEqual(restarted);
  });

  it('keeps settings open and the current progress until the restart succeeds', async () => {
    let respond!: (progress: OnboardingProgress) => void;
    restartOnboarding.mockReturnValue(
      new Promise<OnboardingProgress>((resolve) => {
        respond = resolve;
      })
    );
    const opening = openOnboarding();
    await vi.waitFor(() => expect(restartOnboarding).toHaveBeenCalledOnce());
    expect(closeSettings).not.toHaveBeenCalled();
    expect(onboarding.progress).toEqual(previous);
    respond(restarted);
    await opening;
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(onboarding.progress).toEqual(restarted);
  });

  it('does not restart or discard the workspace when a pending editor save fails', async () => {
    const error = new Error('note could not be saved');
    stopSaving = onAppSuspend(() => Promise.reject(error));
    await expect(openOnboarding()).rejects.toBe(error);
    expect(restartOnboarding).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(onboarding.progress).toEqual(previous);
  });

  it('keeps the current workspace available when the restart fails', async () => {
    const error = new Error('progress document is locked');
    restartOnboarding.mockRejectedValue(error);
    await expect(openOnboarding()).rejects.toBe(error);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(onboarding.progress).toEqual(previous);
  });
});

describe('initial-note handoff', () => {
  it.each([null, 'onboarding-note'])('consumes %s at most once', (noteId) => {
    onboarding.initialNoteId = noteId;
    expect(takeOnboardingNote()).toBe(noteId);
    expect(onboarding.initialNoteId).toBeNull();
    expect(takeOnboardingNote()).toBeNull();
    expect(onboarding.progress).toEqual(previous);
  });
});
