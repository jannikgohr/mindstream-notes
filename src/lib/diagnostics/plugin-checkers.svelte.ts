/**
 * Keeping the diagnostics bus in step with plugin-contributed checkers.
 *
 * Plugins can be enabled, disabled, updated or removed at any time, and the
 * bus registry is imperative, so this reconciles the two: register what is
 * newly present, unregister what is gone, leave the rest alone.
 *
 * Reconciling rather than clearing and rebuilding matters because
 * unregistering a provider drops its cached findings — a rebuild on every
 * change would re-check every open note whenever any unrelated plugin
 * toggled.
 */

import { createHttpCheckerProvider } from './http-checker-provider';
import {
  registerProvider,
  selectedLanguageTags,
  setSpellingOwner
} from './editor-diagnostics.svelte';
import { isCustomWord } from './custom-dictionary.svelte';
import {
  clearCheckerStatus,
  reportCheckerStatus
} from './checker-status.svelte';
import { textCheckerCheck } from '$lib/api/spellcheck';
import { pluginById, pluginTextCheckers } from '$lib/plugins/registry.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import type { DiagnosticKind } from './types';

/** Registered provider id -> its unregister function. */
const active = new Map<string, () => void>();

/**
 * Plugin settings are namespaced `plugins.<pluginId>.<id>`, so a manifest
 * naming a setting is naming its own, and cannot read another plugin's or
 * the app's.
 */
function pluginSetting(
  pluginId: string,
  settingId: string
): string | undefined {
  const value = getSettingValue(`plugins.${pluginId}.${settingId}`);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Stable id for a contribution, namespaced like every other plugin id. */
export function checkerProviderId(pluginId: string, checkerId: string): string {
  return `plugins.${pluginId}.${checkerId}`;
}

/**
 * Register newly-present checkers and drop departed ones.
 *
 * Safe to call as often as plugin state changes; it is a no-op when nothing
 * has moved.
 */
export function syncPluginTextCheckers(): void {
  const contributions = pluginTextCheckers();
  const wanted = new Set<string>();

  for (const { pluginId, checker } of contributions) {
    const id = checkerProviderId(pluginId, checker.id);
    wanted.add(id);
    if (active.has(id)) continue;

    const tagsFor = () => selectedLanguageTags();
    const off = registerProvider(
      createHttpCheckerProvider({
        id,
        kinds: checker.kinds as DiagnosticKind[],
        // The service's own vocabulary, declared by the plugin that knows it.
        categoryKinds: {
          map: (checker.categoryKinds ?? {}) as Record<string, DiagnosticKind>,
          fallback: (checker.defaultKind ?? 'grammar') as DiagnosticKind
        },
        config: () => {
          const endpoint = pluginSetting(pluginId, checker.endpointSetting);
          const tags = tagsFor();
          // No endpoint means the user has not configured the server yet.
          // That must read as "no opinion", not as an error on every
          // paragraph of every note.
          if (!endpoint) return null;
          return {
            endpoint,
            apiKey: checker.apiKeySetting
              ? pluginSetting(pluginId, checker.apiKeySetting)
              : undefined,
            username: checker.usernameSetting
              ? pluginSetting(pluginId, checker.usernameSetting)
              : undefined,
            // One selected language is a fact, not a guess — send it
            // outright. With several, detection decides per paragraph but
            // is narrowed to what the user actually writes, which matters
            // far more for spelling than for grammar: a wrong guess would
            // mis-flag an entire paragraph.
            language: tags.length === 1 ? tags[0] : 'auto',
            preferredVariants: tags.length === 1 ? [] : tags,
            disabledCategories: [
              ...(checker.disabledCategories ?? []),
              // Spelling is the dictionary's unless the user handed it over.
              // Which categories that silences is the service's business, so
              // the plugin names them.
              ...(checksSpelling(pluginId, checker)
                ? []
                : (checker.spellingCategories ?? []))
            ],
            protocol: checker.protocol
          };
        },
        // A remote check API has no per-request word list, so the
        // personal dictionary is applied to its spelling findings here.
        isIgnored: isCustomWord,
        onStatus: (state, detail) => reportCheckerStatus(id, state, detail),
        check: textCheckerCheck
      })
    );
    active.set(id, off);
  }

  for (const [id, off] of [...active]) {
    if (wanted.has(id)) continue;
    off();
    active.delete(id);
    clearCheckerStatus(id);
  }

  // Tell the bus who owns spelling. First claimant wins; with none, the
  // built-in dictionary keeps it.
  const owner = contributions.find(({ pluginId, checker }) =>
    checksSpelling(pluginId, checker)
  );
  setSpellingOwner(
    owner ? checkerProviderId(owner.pluginId, owner.checker.id) : null,
    owner ? (pluginById(owner.pluginId)?.manifest.name ?? owner.pluginId) : ''
  );
}

/**
 * Whether this checker is currently checking spelling.
 *
 * Declaring `spelling` in `kinds` says it CAN; the plugin's own setting
 * says whether it does. Both have to agree, so a user who wants the local
 * dictionary's behaviour can have it without disabling the plugin.
 */
function checksSpelling(
  pluginId: string,
  checker: { kinds: readonly string[]; spellingSetting?: string }
): boolean {
  if (!checker.kinds.includes('spelling')) return false;
  // Which setting decides is the plugin's to name; a checker that declares
  // none simply always does spelling.
  if (!checker.spellingSetting) return true;
  const value = getSettingValue(
    `plugins.${pluginId}.${checker.spellingSetting}`
  );
  return value !== false;
}

/** Drop every plugin checker — used when tearing down. */
export function clearPluginTextCheckers(): void {
  for (const off of active.values()) off();
  active.clear();
}
