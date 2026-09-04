import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '$lib/settings/i18n.svelte';
import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  namespacedPluginKey,
  resolvePluginString,
  resolvePluginStringOptional
} from './plugin-i18n';

const PLUGIN_ID = 'com.example.templates';

function register(): void {
  registerPlugin({
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['notes.create'],
    contributes: {
      i18n: {
        en: {
          'templates.meeting.name': 'Meeting notes',
          'templates.meeting.description': 'Agenda and follow-ups'
        },
        de: { 'templates.meeting.name': 'Besprechungsnotizen' }
      },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'templates.meeting.name',
          noteKind: 'markdown',
          titleTemplate: '{{title}}',
          bodyTemplate: '# {{title}}'
        }
      ]
    }
  });
}

afterEach(() => {
  resetPluginRegistry();
  setLanguage('en');
});

describe('namespacedPluginKey', () => {
  it('prefixes the key with the plugin namespace', () => {
    expect(namespacedPluginKey(PLUGIN_ID, 'templates.meeting.name')).toBe(
      'plugins.com.example.templates.templates.meeting.name'
    );
  });
});

describe('resolvePluginString', () => {
  it('resolves the active locale when present', () => {
    register();
    setLanguage('de');
    expect(resolvePluginString(PLUGIN_ID, 'templates.meeting.name')).toBe(
      'Besprechungsnotizen'
    );
  });

  it('falls back to english when the active locale lacks the key', () => {
    register();
    setLanguage('de'); // de has no description key
    expect(
      resolvePluginString(PLUGIN_ID, 'templates.meeting.description')
    ).toBe('Agenda and follow-ups');
  });

  it('falls back to the namespaced key when the string is missing', () => {
    register();
    expect(resolvePluginString(PLUGIN_ID, 'templates.unknown.name')).toBe(
      'plugins.com.example.templates.templates.unknown.name'
    );
  });

  it('falls back to the namespaced key for an unregistered plugin', () => {
    expect(resolvePluginString('com.ghost.plugin', 'x.y')).toBe(
      'plugins.com.ghost.plugin.x.y'
    );
  });
});

describe('resolvePluginStringOptional', () => {
  it('returns undefined for a missing key instead of a technical label', () => {
    register();
    expect(
      resolvePluginStringOptional(PLUGIN_ID, 'templates.unknown.name')
    ).toBeUndefined();
    expect(resolvePluginStringOptional(PLUGIN_ID, undefined)).toBeUndefined();
  });

  it('resolves a present key', () => {
    register();
    expect(
      resolvePluginStringOptional(PLUGIN_ID, 'templates.meeting.name')
    ).toBe('Meeting notes');
  });
});
