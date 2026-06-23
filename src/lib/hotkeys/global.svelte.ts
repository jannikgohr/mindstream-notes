import { isTauri, syncNativeGlobalShortcuts } from '$lib/api';
import { isMobile } from '$lib/platform';
import {
  commandById,
  isGlobalShortcutCommand,
  type CommandDefinition
} from './catalogue';

export interface GlobalShortcutRegistration {
  commandId: string;
  accelerator: string | null;
}

let activeSignature = '';

function canUseGlobalShortcuts(): boolean {
  return isTauri() && !isMobile();
}

function registrationSignature(registrations: GlobalShortcutRegistration[]) {
  return registrations
    .map((entry) => `${entry.commandId}:${entry.accelerator ?? ''}`)
    .join('|');
}

function runnableGlobalCommand(commandId: string): CommandDefinition | null {
  const cmd = commandById(commandId);
  return cmd?.scope === 'global' && isGlobalShortcutCommand(cmd) ? cmd : null;
}

export async function syncGlobalShortcuts(
  registrations: GlobalShortcutRegistration[]
) {
  if (!canUseGlobalShortcuts()) {
    activeSignature = '';
    return;
  }

  const eligible = registrations.filter(
    (entry): entry is { commandId: string; accelerator: string } =>
      Boolean(entry.accelerator) &&
      Boolean(runnableGlobalCommand(entry.commandId))
  );
  const signature = registrationSignature(eligible);
  if (signature === activeSignature) return;
  activeSignature = signature;

  try {
    await syncNativeGlobalShortcuts(eligible);
  } catch (err) {
    // Surfacing instead of swallowing the IPC error: previous
    // fire-and-forget behaviour hid bad accelerators silently and
    // left every global shortcut unregistered.
    console.error('[hotkeys] syncGlobalShortcuts failed', err);
    // Reset the signature so the next render retries — otherwise a
    // transient failure would lock the app into "looks saved but
    // nothing registered" until the binding changes.
    activeSignature = '';
    throw err;
  }
}

export async function teardownGlobalShortcuts() {
  activeSignature = '';
  await syncNativeGlobalShortcuts([]);
}
