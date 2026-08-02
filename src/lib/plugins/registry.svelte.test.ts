import { afterEach, describe, expect, it } from 'vitest';
import {
  allPlugins,
  enabledPlugins,
  pluginById,
  pluginCommands,
  pluginLoadError,
  pluginNoteExporters,
  pluginNoteExportersForKind,
  pluginSettingsSections,
  pluginSourceLanguage,
  pluginSourceLanguages,
  pluginTemplate,
  pluginTemplates,
  pluginI18nBundles,
  recordPluginLoadError,
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled,
  unregisterPlugin
} from './registry.svelte';

function manifest(id = 'com.example.templates'): Record<string, unknown> {
  return {
    id,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['templates.contribute', 'notes.create'],
    contributes: {
      i18n: { en: { 'templates.meeting.name': 'Meeting notes' } },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'templates.meeting.name',
          noteKind: 'markdown',
          titleTemplate: '{{title}}',
          bodyTemplate: '# {{title}}'
        }
      ],
      settings: [
        {
          sectionId: 'general',
          titleKey: 'settings.general.title',
          settings: [
            {
              id: 'default-template',
              labelKey: 'settings.defaultTemplate.label',
              scope: 'V',
              type: 'toggle',
              default: true
            }
          ]
        }
      ],
      sourceLanguages: [
        {
          id: 'typst',
          aliases: ['typ'],
          extensions: ['typ'],
          provider: { type: 'host', id: 'typst' }
        }
      ],
      commands: [
        {
          id: 'new-meeting',
          labelKey: 'commands.newMeeting.label',
          action: { type: 'createTemplateNote', templateId: 'meeting' }
        }
      ]
    }
  };
}

function exporterManifest(
  id = 'com.example.exporters'
): Record<string, unknown> {
  return {
    id,
    name: 'Exporter',
    version: '1.0.0',
    runtime: 'luau',
    entry: 'main.luau',
    permissions: ['noteExporters.contribute'],
    contributes: {
      i18n: { en: { 'export.pdf': 'PDF' } },
      noteExporters: [
        {
          id: 'pdf',
          labelKey: 'export.pdf',
          noteKind: 'markdown',
          format: 'pdf',
          export: 'exportPdf'
        }
      ]
    }
  };
}

afterEach(() => resetPluginRegistry());

describe('registerPlugin', () => {
  it('registers a valid manifest and exposes its contributions', () => {
    registerPlugin(manifest());
    expect(allPlugins()).toHaveLength(1);
    expect(pluginTemplates()).toHaveLength(1);
    expect(pluginTemplates()[0].pluginId).toBe('com.example.templates');
    expect(pluginSettingsSections()).toHaveLength(1);
    expect(pluginCommands()).toHaveLength(1);
    expect(pluginSourceLanguages()).toHaveLength(1);
    expect(pluginNoteExporters()).toHaveLength(0);
    expect(pluginSourceLanguage('typ')?.language.id).toBe('typst');
    expect(pluginI18nBundles()['com.example.templates']).toBeTruthy();
  });

  it('throws on an invalid manifest and does not register anything', () => {
    expect(() => registerPlugin({ id: 'nope' })).toThrow();
    expect(allPlugins()).toHaveLength(0);
  });

  it('replaces an existing registration on re-register', () => {
    registerPlugin(manifest());
    registerPlugin(manifest()); // same id again
    expect(allPlugins()).toHaveLength(1);
  });

  it('clears a prior load error when the plugin later registers', () => {
    recordPluginLoadError('com.example.templates', 'boom');
    expect(pluginLoadError('com.example.templates')).toBe('boom');
    registerPlugin(manifest());
    expect(pluginLoadError('com.example.templates')).toBeUndefined();
  });
});

describe('enabled/disabled filtering', () => {
  it('excludes disabled plugins from the merged views but keeps them registered', () => {
    registerPlugin(manifest());
    setPluginEnabled('com.example.templates', false);
    expect(allPlugins()).toHaveLength(1);
    expect(enabledPlugins()).toHaveLength(0);
    expect(pluginTemplates()).toHaveLength(0);
    expect(pluginSettingsSections()).toHaveLength(0);
    expect(pluginCommands()).toHaveLength(0);
    expect(pluginSourceLanguages()).toHaveLength(0);
    expect(pluginNoteExporters()).toHaveLength(0);
    expect(pluginI18nBundles()).toEqual({});
    expect(pluginTemplate('com.example.templates', 'meeting')).toBeUndefined();
  });

  it('re-enabling restores the contributions', () => {
    registerPlugin(manifest(), { enabled: false });
    expect(pluginTemplates()).toHaveLength(0);
    setPluginEnabled('com.example.templates', true);
    expect(pluginTemplates()).toHaveLength(1);
  });

  it('exposes note exporters and filters them by note kind', () => {
    registerPlugin(exporterManifest());
    expect(pluginNoteExporters()).toHaveLength(1);
    expect(pluginNoteExportersForKind('markdown')[0].exporter.id).toBe('pdf');
    expect(pluginNoteExportersForKind('kanban')).toEqual([]);

    setPluginEnabled('com.example.exporters', false);
    expect(pluginNoteExportersForKind('markdown')).toEqual([]);
  });
});

describe('lookups and teardown', () => {
  it('resolves a single template by id', () => {
    registerPlugin(manifest());
    const ref = pluginTemplate('com.example.templates', 'meeting');
    expect(ref?.template.titleTemplate).toBe('{{title}}');
    expect(pluginTemplate('com.example.templates', 'missing')).toBeUndefined();
  });

  it('unregisterPlugin removes state entirely', () => {
    registerPlugin(manifest());
    unregisterPlugin('com.example.templates');
    expect(pluginById('com.example.templates')).toBeUndefined();
    expect(pluginTemplates()).toHaveLength(0);
  });

  it('merges templates from multiple plugins', () => {
    registerPlugin(manifest('com.a.templates'));
    registerPlugin(manifest('com.b.templates'));
    expect(pluginTemplates()).toHaveLength(2);
  });
});
