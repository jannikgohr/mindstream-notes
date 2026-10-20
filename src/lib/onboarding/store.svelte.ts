import {
  restartOnboarding,
  type OnboardingProgress
} from '$lib/api/onboarding';
import { closeSettings } from '$lib/settings/store.svelte';

export const onboarding = $state<{
  progress: OnboardingProgress | null;
  initialNoteId: string | null;
  finishing: boolean;
}>({
  progress: null,
  initialNoteId: null,
  finishing: false
});

export async function openOnboarding(): Promise<void> {
  const { flushPendingEditorSaves } = await import('$lib/editor/suspend-flush');
  await flushPendingEditorSaves();
  const progress = await restartOnboarding();
  closeSettings();
  onboarding.progress = progress;
}

export function takeOnboardingNote(): string | null {
  const id = onboarding.initialNoteId;
  onboarding.initialNoteId = null;
  return id;
}
