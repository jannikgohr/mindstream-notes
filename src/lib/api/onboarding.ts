import {
  assertBoolean,
  assertRecord,
  assertString,
  invokeOrFallback,
  TauriCommandName
} from './core';
import { createNote } from './notes';
import { mockApi } from './mock-store';

export const ONBOARDING_STEPS = [
  'account',
  'appearance',
  'editing',
  'start'
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export interface OnboardingProgress {
  version: 1;
  id: string;
  status: 'inProgress' | 'completed' | 'skipped' | 'existing';
  step: OnboardingStep;
  vaultId: string | null;
  freshInstall: boolean;
}
export interface InitialNote {
  title: string;
  body: string;
}
/** A demo note as the editor rendered it, see $lib/onboarding/demo-notes. */
export interface DemoNote extends InitialNote {
  slug: string;
  lang: string;
  /** The editor document the note starts from. Its hash names the note. */
  yrsState: number[];
}
const STORAGE_KEY = 'mindstream:onboarding:v1';

export function parseOnboarding(value: unknown): OnboardingProgress {
  const raw = assertRecord(value, 'onboarding');
  const id = assertString(raw.id, 'onboarding.id');
  if (
    raw.version !== 1 ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
    !['inProgress', 'completed', 'skipped', 'existing'].includes(
      String(raw.status)
    ) ||
    !ONBOARDING_STEPS.includes(raw.step as OnboardingStep) ||
    (raw.vaultId !== null && typeof raw.vaultId !== 'string')
  ) {
    throw new Error('Invalid onboarding progress');
  }
  return {
    version: 1,
    id,
    status: raw.status as OnboardingProgress['status'],
    step: raw.step as OnboardingStep,
    vaultId: raw.vaultId as string | null,
    freshInstall: assertBoolean(raw.freshInstall, 'onboarding.freshInstall')
  };
}

function browserProgress(): OnboardingProgress {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved
    ? parseOnboarding(JSON.parse(saved))
    : {
        version: 1,
        id: crypto.randomUUID(),
        status: 'skipped',
        step: 'account',
        vaultId: 'default',
        freshInstall: false
      };
}
function saveBrowser(progress: OnboardingProgress): OnboardingProgress {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  return progress;
}
function browserOwned(id: string): OnboardingProgress {
  const progress = browserProgress();
  if (progress.id !== id || progress.status !== 'inProgress')
    throw new Error('Onboarding session changed; reopen setup');
  return progress;
}
export function getOnboarding(): Promise<OnboardingProgress> {
  return invokeOrFallback(
    TauriCommandName.GetOnboarding,
    undefined,
    browserProgress,
    parseOnboarding
  );
}
export function restartOnboarding(): Promise<OnboardingProgress> {
  return invokeOrFallback(
    TauriCommandName.RestartOnboarding,
    undefined,
    () => {
      const previous = browserProgress();
      return previous.status === 'inProgress'
        ? previous
        : saveBrowser({
            ...previous,
            id: crypto.randomUUID(),
            status: 'inProgress',
            step: 'account',
            freshInstall: false
          });
    },
    parseOnboarding
  );
}
export function saveOnboardingStep(
  id: string,
  step: OnboardingStep
): Promise<OnboardingProgress> {
  return invokeOrFallback(
    TauriCommandName.SaveOnboardingStep,
    { id, step },
    () => saveBrowser({ ...browserOwned(id), step }),
    parseOnboarding
  );
}
export function finishOnboarding(
  id: string,
  skipped: boolean,
  initialNote: InitialNote | null,
  demoNotes: DemoNote[] = []
): Promise<{
  progress: OnboardingProgress;
  noteId: string | null;
}> {
  return invokeOrFallback(
    TauriCommandName.FinishOnboarding,
    { id, skipped, initialNote, demoNotes },
    async () => {
      const previous = browserOwned(id);
      const ids: string[] = [];
      if (initialNote) ids.push((await createNote(initialNote)).id);
      else
        for (const note of demoNotes)
          ids.push((await mockApi.insertDemoNote(note)).id);
      return {
        progress: saveBrowser({
          ...previous,
          status: skipped ? 'skipped' : 'completed'
        }),
        noteId: ids[0] ?? null
      };
    },
    (value) => {
      const raw = assertRecord(value, 'finished onboarding');
      return {
        progress: parseOnboarding(raw.progress),
        noteId:
          raw.noteId === null
            ? null
            : assertString(raw.noteId, 'onboarding.noteId')
      };
    }
  );
}
