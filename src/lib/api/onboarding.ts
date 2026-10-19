import {
  assertBoolean,
  assertRecord,
  assertString,
  invokeOrFallback,
  TauriCommandName
} from './core';
import { createNote } from './notes';

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
  initialNote: InitialNote | null
): Promise<{
  progress: OnboardingProgress;
  noteId: string | null;
}> {
  return invokeOrFallback(
    TauriCommandName.FinishOnboarding,
    { id, skipped, initialNote },
    async () => {
      const previous = browserOwned(id);
      const note = initialNote ? await createNote(initialNote) : null;
      return {
        progress: saveBrowser({
          ...previous,
          status: skipped ? 'skipped' : 'completed'
        }),
        noteId: note?.id ?? null
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
