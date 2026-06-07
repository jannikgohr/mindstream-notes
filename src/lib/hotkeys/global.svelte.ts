import {
  register,
  unregister,
  type ShortcutEvent
} from '@tauri-apps/plugin-global-shortcut';
import { Window } from '@tauri-apps/api/window';
import { isTauri } from '$lib/api';
import { isMobile } from '$lib/platform';
import {
  commandById,
  isGlobalShortcutCommand,
  type CommandDefinition
} from './commands';
import { emitCommand } from './bus.svelte';

export interface GlobalShortcutRegistration {
  commandId: string;
  accelerator: string | null;
}

let registeredShortcuts: string[] = [];
let activeSignature = '';
let syncGeneration = 0;

function canUseGlobalShortcuts(): boolean {
  return isTauri() && !isMobile();
}

async function focusMainWindow() {
  try {
    const win = (await Window.getByLabel('main')) ?? Window.getCurrent();
    if (await win.isMinimized()) {
      await win.unminimize();
    }
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.warn('[global-shortcuts] failed to focus main window', err);
  }
}

async function clearRegisteredShortcuts() {
  if (registeredShortcuts.length === 0) return;
  const previous = registeredShortcuts;
  registeredShortcuts = [];
  try {
    await unregister(previous);
  } catch (err) {
    console.warn('[global-shortcuts] unregister failed', err);
  }
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

async function registerGlobalShortcut(
  commandId: string,
  accelerator: string,
  generation: number
) {
  const cmd = runnableGlobalCommand(commandId);
  if (!cmd) return;

  try {
    await register(accelerator, (event: ShortcutEvent) => {
      if (generation !== syncGeneration) return;
      if (event.state !== 'Pressed') return;
      void focusMainWindow().finally(() => {
        emitCommand(cmd);
      });
    });
    registeredShortcuts.push(accelerator);
  } catch (err) {
    console.warn(
      '[global-shortcuts] failed to register',
      commandId,
      accelerator,
      err
    );
  }
}

export async function syncGlobalShortcuts(
  registrations: GlobalShortcutRegistration[]
) {
  if (!canUseGlobalShortcuts()) {
    activeSignature = '';
    registeredShortcuts = [];
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

  const generation = ++syncGeneration;
  await clearRegisteredShortcuts();

  for (const entry of eligible) {
    if (generation !== syncGeneration) return;
    await registerGlobalShortcut(
      entry.commandId,
      entry.accelerator,
      generation
    );
  }
}

export async function teardownGlobalShortcuts() {
  activeSignature = '';
  syncGeneration++;
  await clearRegisteredShortcuts();
}
