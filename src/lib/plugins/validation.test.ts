import { describe, expect, it } from 'vitest';
import { PluginValidationError, validateManifest } from './validation';
import type { PluginManifest } from './types';

/** A minimal manifest that passes validation; override to probe failures. */
function validManifest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'com.example.templates',
    name: 'Example Templates',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['templates.contribute', 'notes.create'],
    contributes: {
      i18n: {
        en: { 'templates.meeting.name': 'Meeting notes' },
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
      commands: [
        {
          id: 'new-meeting',
          labelKey: 'commands.newMeeting.label',
          defaultBinding: 'mod+alt+m',
          action: { type: 'createTemplateNote', templateId: 'meeting' }
        }
      ]
    },
    ...overrides
  };
}

/** Deep-clone + mutate `contributes` for the failure cases. */
function withContributes(
  mutate: (c: Record<string, unknown>) => void
): Record<string, unknown> {
  const m = validManifest();
  mutate(m.contributes as Record<string, unknown>);
  return m;
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest and returns it typed', () => {
    const m = validManifest();
    const result: PluginManifest = validateManifest(m);
    expect(result.id).toBe('com.example.templates');
  });

  it('throws PluginValidationError carrying the plugin id', () => {
    try {
      validateManifest(validManifest({ version: '' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginValidationError);
      expect((err as PluginValidationError).pluginId).toBe(
        'com.example.templates'
      );
    }
  });

  it('rejects a non-namespaced plugin id', () => {
    expect(() => validateManifest(validManifest({ id: 'templates' }))).toThrow(
      /must be a stable, dotted/
    );
  });

  it('rejects an uppercase plugin id', () => {
    expect(() =>
      validateManifest(validManifest({ id: 'com.Example.Templates' }))
    ).toThrow(PluginValidationError);
  });

  it('rejects an unknown runtime', () => {
    expect(() =>
      validateManifest(validManifest({ runtime: 'js', entry: 'main.js' }))
    ).toThrow(/expected "manifest-only" or "luau"/);
  });

  it('accepts a luau runtime with a safe entry', () => {
    const m = validateManifest(
      validManifest({ runtime: 'luau', entry: 'main.luau' })
    );
    expect(m.runtime).toBe('luau');
    expect(m.entry).toBe('main.luau');
  });

  it('requires an entry for a luau runtime', () => {
    expect(() => validateManifest(validManifest({ runtime: 'luau' }))).toThrow(
      /manifest.entry must be a non-empty string/
    );
  });

  it('rejects a traversing or non-.luau entry', () => {
    for (const entry of [
      '../evil.luau',
      'sub/main.luau',
      'main.lua',
      'main.js',
      '.luau'
    ]) {
      expect(() =>
        validateManifest(validManifest({ runtime: 'luau', entry }))
      ).toThrow(/must be a plain \.luau filename/);
    }
  });

  it('rejects an entry on a manifest-only runtime', () => {
    expect(() =>
      validateManifest(validManifest({ entry: 'main.luau' }))
    ).toThrow(/only valid for runtime "luau"/);
  });

  it('rejects unknown permissions', () => {
    expect(() =>
      validateManifest(validManifest({ permissions: ['notes.write'] }))
    ).toThrow(/unknown permission/);
  });

  it('requires templates.contribute when contributing templates', () => {
    expect(() =>
      validateManifest(validManifest({ permissions: ['notes.create'] }))
    ).toThrow(/missing the "templates.contribute" permission/);
  });

  it('rejects a non-markdown note kind', () => {
    const m = withContributes((c) => {
      (c.noteTemplates as Record<string, unknown>[])[0].noteKind = 'freeform';
    });
    expect(() => validateManifest(m)).toThrow(/only "markdown" is allowed/);
  });

  it('rejects a select variable without options', () => {
    const m = withContributes((c) => {
      (c.noteTemplates as Record<string, unknown>[])[0].variables = [
        { id: 'kind', labelKey: 'templates.meeting.kind', type: 'select' }
      ];
    });
    expect(() => validateManifest(m)).toThrow(/must list at least one option/);
  });

  it('rejects duplicate template ids', () => {
    const m = withContributes((c) => {
      const t = (c.noteTemplates as Record<string, unknown>[])[0];
      (c.noteTemplates as unknown[]).push({ ...t });
    });
    expect(() => validateManifest(m)).toThrow(/duplicate template id/);
  });

  it('rejects a command referencing a missing template', () => {
    const m = withContributes((c) => {
      (c.commands as Record<string, unknown>[])[0].action = {
        type: 'createTemplateNote',
        templateId: 'does-not-exist'
      };
    });
    expect(() => validateManifest(m)).toThrow(/does not contribute/);
  });

  it('rejects an unsupported command action', () => {
    const m = withContributes((c) => {
      (c.commands as Record<string, unknown>[])[0].action = {
        type: 'runScript'
      };
    });
    expect(() => validateManifest(m)).toThrow(/not a supported command action/);
  });

  it('rejects duplicate setting ids across sections', () => {
    const m = withContributes((c) => {
      (c.settings as Record<string, unknown>[]).push({
        sectionId: 'other',
        titleKey: 'settings.other.title',
        settings: [
          {
            id: 'default-template',
            labelKey: 'settings.defaultTemplate.label',
            scope: 'D',
            type: 'toggle'
          }
        ]
      });
    });
    expect(() => validateManifest(m)).toThrow(/duplicate setting id/);
  });

  it('requires an english i18n bundle when translations are present', () => {
    const m = withContributes((c) => {
      c.i18n = { de: { 'templates.meeting.name': 'Besprechung' } };
    });
    expect(() => validateManifest(m)).toThrow(/must include an "en" bundle/);
  });

  it('accepts a manifest with no contributions beyond an empty block', () => {
    const m = validManifest({ permissions: [], contributes: {} });
    expect(() => validateManifest(m)).not.toThrow();
  });
});
