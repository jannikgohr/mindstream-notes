import { afterEach, describe, expect, it } from 'vitest';
import {
  getOnboarding,
  parseOnboarding,
  restartOnboarding,
  saveOnboardingStep,
  finishOnboarding
} from './onboarding';

afterEach(() => localStorage.removeItem('mindstream:onboarding:v1'));

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
});
