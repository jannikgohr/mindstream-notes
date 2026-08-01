import { describe, expect, it } from 'vitest';
import { PluginValidationError, validateManifest } from './validation';
import type { PluginManifest } from './types';
import typstPrototypeManifest from '../../../plugins/typst-prototype/manifest.json';

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

  it('accepts the bundled Typst prototype manifest', () => {
    const result = validateManifest(typstPrototypeManifest);
    // The prototype renders through the native `typst` binary, not a webview.
    expect(result.contributes.nativeTools).toEqual([
      expect.objectContaining({ id: 'typst', binaryName: 'typst' })
    ]);
    const render = result.contributes.noteKinds?.[0].render;
    expect(render?.requiresNativeTool).toBe('typst');
    expect(render?.previewMime).toBe('image/svg+xml');
    expect(render?.webview).toBeUndefined();
    expect(result.contributes.artifacts).toBeUndefined();
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
    ).toThrow(/expected "manifest-only", "luau", or "wasm"/);
  });

  it('accepts a luau runtime with a safe entry', () => {
    const m = validateManifest(
      validManifest({ runtime: 'luau', entry: 'main.luau' })
    );
    expect(m.runtime).toBe('luau');
    expect(m.entry).toBe('main.luau');
  });

  it('accepts a wasm runtime with a safe entry and limits', () => {
    const m = validateManifest(
      validManifest({
        runtime: 'wasm',
        entry: 'main.wasm',
        limits: { memoryBytes: 134217728, timeoutMs: 5000, fuel: 1000000 }
      })
    );
    expect(m.runtime).toBe('wasm');
    expect(m.entry).toBe('main.wasm');
    expect(m.limits?.fuel).toBe(1000000);
  });

  it('requires an entry for scripted runtimes', () => {
    expect(() => validateManifest(validManifest({ runtime: 'luau' }))).toThrow(
      /manifest.entry must be a non-empty string/
    );
    expect(() => validateManifest(validManifest({ runtime: 'wasm' }))).toThrow(
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

  it('rejects a traversing or non-.wasm entry', () => {
    for (const entry of [
      '../evil.wasm',
      'sub/main.wasm',
      'main.luau',
      'main.js',
      '.wasm'
    ]) {
      expect(() =>
        validateManifest(validManifest({ runtime: 'wasm', entry }))
      ).toThrow(/must be a plain \.wasm filename/);
    }
  });

  it('rejects an entry on a manifest-only runtime', () => {
    expect(() =>
      validateManifest(validManifest({ entry: 'main.luau' }))
    ).toThrow(/only valid for runtime "luau" or "wasm"/);
  });

  it('rejects invalid limits', () => {
    expect(() =>
      validateManifest(validManifest({ limits: { timeoutMs: -1 } }))
    ).toThrow(/manifest.limits.timeoutMs/);
    expect(() =>
      validateManifest(validManifest({ limits: { fuel: 1000 } }))
    ).toThrow(/fuel is only valid/);
  });

  it('accepts an optional descriptionKey and rejects a bad one', () => {
    expect(
      validateManifest(validManifest({ descriptionKey: 'plugin.description' }))
        .descriptionKey
    ).toBe('plugin.description');
    expect(() =>
      validateManifest(validManifest({ descriptionKey: 'has spaces' }))
    ).toThrow(/manifest.descriptionKey/);
  });

  it('accepts file-backed documentation sections', () => {
    const m = withContributes((c) => {
      c.documentation = [
        { file: 'docs/getting-started.md' },
        { file: 'docs/placeholders.de.md' }
      ];
    });
    const result = validateManifest(m);
    expect(result.contributes.documentation).toHaveLength(2);
  });

  it('rejects a documentation path that escapes the plugin dir', () => {
    for (const file of [
      '../secret.md',
      'docs/../../secret.md',
      '/etc/passwd.md',
      'docs\\win.md',
      'docs/notes.txt'
    ]) {
      const m = withContributes((c) => {
        c.documentation = [{ file }];
      });
      expect(() => validateManifest(m)).toThrow(/safe relative \.md path/);
    }
  });

  it('rejects duplicate documentation files', () => {
    const m = withContributes((c) => {
      c.documentation = [{ file: 'docs/a.md' }, { file: 'docs/a.md' }];
    });
    expect(() => validateManifest(m)).toThrow(/duplicate documentation file/);
  });

  // --- Toolbar buttons + Luau macros ---
  const luauButton = {
    id: 'new-from-template',
    location: 'file-tree',
    labelKey: 'toolbar.newFromTemplate',
    icon: 'icons/templates.svg',
    action: { type: 'script', export: 'newFromTemplate' }
  };
  /** A luau manifest (toolbar/render require it) with `mutate`d contributes. */
  function luauManifest(
    mutate: (c: Record<string, unknown>) => void
  ): Record<string, unknown> {
    const m = validManifest({ runtime: 'luau', entry: 'main.luau' });
    mutate(m.contributes as Record<string, unknown>);
    return m;
  }

  it('accepts a toolbar button on a luau plugin', () => {
    const m = luauManifest((c) => {
      c.toolbar = [luauButton];
    });
    expect(validateManifest(m).contributes.toolbar).toHaveLength(1);
  });

  it('accepts a toolbar button on a wasm plugin', () => {
    const m = validManifest({ runtime: 'wasm', entry: 'main.wasm' });
    (m.contributes as Record<string, unknown>).toolbar = [luauButton];
    expect(validateManifest(m).contributes.toolbar).toHaveLength(1);
  });

  it('rejects toolbar buttons on a manifest-only runtime', () => {
    const m = withContributes((c) => {
      c.toolbar = [luauButton];
    });
    expect(() => validateManifest(m)).toThrow(
      /require runtime "luau" or "wasm"/
    );
  });

  it('rejects a toolbar icon that is not a safe .svg path', () => {
    for (const icon of ['../evil.svg', 'icons/logo.png', '/abs/x.svg']) {
      const m = luauManifest((c) => {
        c.toolbar = [{ ...luauButton, icon }];
      });
      expect(() => validateManifest(m)).toThrow(/safe relative .svg path/);
    }
  });

  it('rejects an unknown toolbar location and action type', () => {
    const badLoc = luauManifest((c) => {
      c.toolbar = [{ ...luauButton, location: 'sidebar' }];
    });
    expect(() => validateManifest(badLoc)).toThrow(/toolbar location/);
    const badAction = luauManifest((c) => {
      c.toolbar = [{ ...luauButton, action: { type: 'open-url' } }];
    });
    expect(() => validateManifest(badAction)).toThrow(
      /supported toolbar action/
    );
  });

  it('accepts a template render export on a luau plugin, rejects it otherwise', () => {
    const ok = luauManifest((c) => {
      (c.noteTemplates as Record<string, unknown>[])[0].render = 'render';
    });
    expect(() => validateManifest(ok)).not.toThrow();
    const bad = withContributes((c) => {
      (c.noteTemplates as Record<string, unknown>[])[0].render = 'render';
    });
    expect(() => validateManifest(bad)).toThrow(/requires runtime "luau"/);
  });

  it('accepts a template render export on a wasm plugin', () => {
    const m = validManifest({ runtime: 'wasm', entry: 'main.wasm' });
    (
      (m.contributes as Record<string, unknown>).noteTemplates as Record<
        string,
        unknown
      >[]
    )[0].render = 'render';
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('rejects unknown permissions', () => {
    expect(() =>
      validateManifest(validManifest({ permissions: ['notes.write'] }))
    ).toThrow(/unknown permission/);
  });

  it('accepts a disabled-by-default builtin manifest hint', () => {
    const m = validManifest({ enabledByDefault: false });
    expect(validateManifest(m).enabledByDefault).toBe(false);
  });

  it('rejects non-boolean default enablement hints', () => {
    expect(() =>
      validateManifest(validManifest({ enabledByDefault: 'false' }))
    ).toThrow(/enabledByDefault/);
  });

  it('accepts declared plugin artifacts behind the download permission', () => {
    const m = validManifest({
      permissions: [
        'templates.contribute',
        'notes.create',
        'pluginArtifacts.download'
      ]
    });
    (m.contributes as Record<string, unknown>).artifacts = [
      {
        id: 'typst-compiler',
        kind: 'wasm',
        version: '0.1.0',
        url: 'https://example.com/typst.wasm',
        sha256: 'a'.repeat(64),
        fileName: 'typst.wasm',
        sizeBytes: 123
      }
    ];
    expect(validateManifest(m).contributes.artifacts).toHaveLength(1);
  });

  it('accepts webScript artifacts for iframe preview runtimes', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'pluginArtifacts.download',
        'pluginWebviews.allowEval'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.artifacts = [
      {
        id: 'preview-glue',
        kind: 'webScript',
        version: '0.7.0',
        url: 'https://example.com/preview.mjs',
        sha256: 'a'.repeat(64),
        fileName: 'preview.mjs'
      }
    ];
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          webview: {
            entry: 'preview.mjs',
            allowEval: true,
            artifacts: ['preview-glue']
          }
        }
      }
    ];
    expect(
      validateManifest(m).contributes.noteKinds?.[0].render.webview
    ).toEqual({
      entry: 'preview.mjs',
      allowEval: true,
      artifacts: ['preview-glue']
    });
  });

  it('rejects iframe preview eval without the eval permission', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          webview: { entry: 'preview.mjs', allowEval: true }
        }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/pluginWebviews\.allowEval/);
  });

  it('rejects iframe preview runtimes that reference unsafe or undeclared assets', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          webview: { entry: '../preview.mjs', artifacts: ['missing'] }
        }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/webview.entry/);
    (
      (contributes.noteKinds as Record<string, unknown>[])[0].render as Record<
        string,
        unknown
      >
    ).webview = { entry: 'preview.mjs', artifacts: ['missing'] };
    expect(() => validateManifest(m)).toThrow(/undeclared artifact/);
  });

  it('accepts declared native tools behind the native permission', () => {
    const m = validManifest({
      permissions: [
        'templates.contribute',
        'notes.create',
        'nativeTools.runDeclared'
      ]
    });
    (m.contributes as Record<string, unknown>).nativeTools = [
      {
        id: 'typst',
        binaryName: 'typst',
        descriptionKey: 'native.typst.description'
      }
    ];
    expect(validateManifest(m).contributes.nativeTools).toHaveLength(1);
  });

  it('rejects native tools without permission or with path-shaped binaries', () => {
    const m = validManifest();
    (m.contributes as Record<string, unknown>).nativeTools = [
      { id: 'typst', binaryName: '../typst' }
    ];
    expect(() => validateManifest(m)).toThrow(/binaryName/);
    (m.contributes as Record<string, unknown>).nativeTools = [
      { id: 'typst', binaryName: 'typst' }
    ];
    expect(() => validateManifest(m)).toThrow(/nativeTools\.runDeclared/);
  });

  it('rejects artifacts without the download permission', () => {
    const m = validManifest();
    (m.contributes as Record<string, unknown>).artifacts = [
      {
        id: 'typst-compiler',
        kind: 'wasm',
        version: '0.1.0',
        url: 'https://example.com/typst.wasm',
        sha256: 'a'.repeat(64),
        fileName: 'typst.wasm'
      }
    ];
    expect(() => validateManifest(m)).toThrow(/pluginArtifacts\.download/);
  });

  it('rejects unsafe artifact download declarations', () => {
    const m = validManifest({
      permissions: [
        'templates.contribute',
        'notes.create',
        'pluginArtifacts.download'
      ]
    });
    (m.contributes as Record<string, unknown>).artifacts = [
      {
        id: 'typst-compiler',
        kind: 'wasm',
        version: '0.1.0',
        url: 'http://example.com/typst.wasm',
        sha256: 'not-a-digest',
        fileName: '../typst.wasm'
      }
    ];
    expect(() => validateManifest(m)).toThrow(/HTTPS|sha256|fileName/);
  });

  it('requires templates.contribute when contributing templates', () => {
    expect(() =>
      validateManifest(validManifest({ permissions: ['notes.create'] }))
    ).toThrow(/missing the "templates.contribute" permission/);
  });

  it('accepts a plugin-owned note kind and a template that creates it', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        sourceLanguage: 'typst',
        viewModePreviewIcon: 'bookText',
        render: { export: 'renderDocument', previewMime: 'text/html' }
      }
    ];
    (contributes.noteTemplates as Record<string, unknown>[])[0].noteKind =
      'plugin.com.example.templates.document';
    expect(validateManifest(m).contributes.noteKinds).toHaveLength(1);
  });

  it('accepts a note-kind render that requires a declared native tool', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeTools.runDeclared'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.nativeTools = [{ id: 'typst', binaryName: 'typst' }];
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          previewMime: 'image/svg+xml',
          requiresNativeTool: 'typst'
        }
      }
    ];
    expect(
      validateManifest(m).contributes.noteKinds?.[0].render.requiresNativeTool
    ).toBe('typst');
  });

  it('rejects requiresNativeTool for an undeclared tool', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeTools.runDeclared'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          previewMime: 'image/svg+xml',
          requiresNativeTool: 'ghost'
        }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/undeclared native tool/);
  });

  it('rejects unknown plugin note kind preview mode icons', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        viewModePreviewIcon: 'scroll',
        render: { export: 'renderDocument', previewMime: 'text/html' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/viewModePreviewIcon/);
  });

  it('accepts note-editor toolbar source actions for plugin-owned note kinds', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: { export: 'renderDocument', previewMime: 'text/html' }
      }
    ];
    contributes.toolbar = [
      {
        id: 'strong',
        location: 'note-editor',
        noteKind: 'document',
        labelKey: 'toolbar.strong',
        icon: 'icons/strong.svg',
        action: {
          type: 'wrapSelection',
          before: '*',
          after: '*',
          placeholder: 'strong'
        }
      },
      {
        id: 'heading',
        location: 'note-editor',
        noteKind: 'document',
        labelKey: 'toolbar.heading',
        icon: 'icons/heading.svg',
        action: { type: 'insertText', text: '= ', cursorOffset: 2 }
      }
    ];
    expect(validateManifest(m).contributes.toolbar).toHaveLength(2);
  });

  it('accepts note-editor toolbarItem actions without plugin icons or labels', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: { export: 'renderDocument', previewMime: 'text/html' }
      }
    ];
    contributes.toolbar = [
      {
        id: 'strong',
        location: 'note-editor',
        noteKind: 'document',
        toolbarItem: 'bold',
        action: { type: 'wrapSelection', before: '*', after: '*' }
      }
    ];
    expect(validateManifest(m).contributes.toolbar?.[0].toolbarItem).toBe(
      'bold'
    );
  });

  it('rejects unknown built-in editor toolbar items', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: { export: 'renderDocument' }
      }
    ];
    contributes.toolbar = [
      {
        id: 'mystery',
        location: 'note-editor',
        noteKind: 'document',
        toolbarItem: 'mystery',
        action: { type: 'insertText', text: '?' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/supported editor toolbar item/);
  });

  it('rejects note-editor toolbar buttons for undeclared note kinds', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ]
    });
    (m.contributes as Record<string, unknown>).toolbar = [
      {
        id: 'strong',
        location: 'note-editor',
        noteKind: 'document',
        labelKey: 'toolbar.strong',
        icon: 'icons/strong.svg',
        action: { type: 'insertText', text: '= ' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/does not contribute/);
  });

  it('rejects source-edit toolbar actions outside note editors', () => {
    const m = luauManifest((c) => {
      c.toolbar = [
        {
          ...luauButton,
          action: { type: 'insertText', text: '= ', cursorOffset: 2 }
        }
      ];
    });
    expect(() => validateManifest(m)).toThrow(/only valid for note-editor/);
  });

  it('requires noteKinds.contribute when contributing note kinds', () => {
    const m = validManifest({ runtime: 'luau', entry: 'main.luau' });
    (m.contributes as Record<string, unknown>).noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: { export: 'renderDocument' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(
      /missing the "noteKinds.contribute"/
    );
  });

  it('rejects a template for an undeclared plugin note kind', () => {
    const m = withContributes((c) => {
      (c.noteTemplates as Record<string, unknown>[])[0].noteKind =
        'plugin.com.example.templates.document';
    });
    expect(() => validateManifest(m)).toThrow(/declared by this plugin/);
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
