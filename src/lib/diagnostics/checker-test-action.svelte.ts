/**
 * The "Test connection" button behind a plugin-contributed text checker.
 *
 * Host-implemented, like the checker itself: a manifest asks for
 * `textChecker.test` and the app supplies the behaviour. That keeps it
 * generic — the action is described in terms of the contribution, so any
 * plugin contributing a checker gets it, and nothing LanguageTool-specific
 * appears in core settings code.
 *
 * The result goes to the notification centre rather than being returned,
 * because the settings dialog's button contract is fire-and-forget.
 */

import { languagetoolTestConnection } from '$lib/api/spellcheck';
import { upsertNotification } from '$lib/notifications/store.svelte';
import { pluginTextCheckers } from '$lib/plugins/registry.svelte';
import { registerSettingAction } from '$lib/settings/registry.svelte';
import { resolvePluginString } from '$lib/plugins/plugin-i18n';
import { getSettingValue } from '$lib/settings/store.svelte';

function pluginSetting(
  pluginId: string,
  settingId: string
): string | undefined {
  const value = getSettingValue(`plugins.${pluginId}.${settingId}`);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function report(pluginId: string, ok: boolean, detail: string): void {
  upsertNotification({
    // Stable id per plugin: testing repeatedly replaces the previous result
    // instead of stacking identical notifications.
    id: `text-checker-test:${pluginId}`,
    kind: 'generic',
    widgetType: 'generic',
    createdAt: Date.now(),
    data: {
      title: resolvePluginString(pluginId, ok ? 'test.ok' : 'test.failed'),
      message: detail
    }
  });
}

/**
 * Wire up the test action for every plugin that contributes a checker.
 *
 * Called alongside the checker sync, so a plugin enabled after startup gets
 * a working button without a reload.
 */
export function syncCheckerTestActions(): void {
  for (const { pluginId, checker } of pluginTextCheckers()) {
    registerSettingAction(`plugins.${pluginId}.textChecker.test`, async () => {
      const endpoint = pluginSetting(pluginId, checker.endpointSetting);
      if (!endpoint) {
        report(
          pluginId,
          false,
          resolvePluginString(pluginId, 'test.noEndpoint')
        );
        return;
      }

      const result = await languagetoolTestConnection({
        endpoint,
        apiKey: checker.apiKeySetting
          ? pluginSetting(pluginId, checker.apiKeySetting)
          : undefined,
        username: checker.usernameSetting
          ? pluginSetting(pluginId, checker.usernameSetting)
          : undefined
      });
      report(pluginId, result.ok, result.detail);
    });
  }
}
