import { describe, expect, it } from 'vitest';
import { PluginValidationError, validateManifest } from './validation';
import type { PluginManifest } from './types';
import typstManifest from '../../../plugins/typst/manifest.json';
import languagetoolManifest from '../../../plugins/languagetool/manifest.json';

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

  it('accepts the bundled LanguageTool manifest', () => {
    // Guards the shipped bundle itself. A manifest that fails validation
    // does not surface as an error — the plugin simply stops appearing in
    // the app, which is how adding the test-connection button silently
    // delisted it.
    const result = validateManifest(languagetoolManifest);
    expect(result.contributes.textCheckers).toEqual([
      expect.objectContaining({ id: 'grammar', protocol: 'languagetool' })
    ]);
    // Spelling is offered, not forced: TYPOS is no longer disabled in the
    // manifest, and the plugin's own setting decides whether LanguageTool
    // takes spelling over from the built-in dictionary.
    expect(result.contributes.textCheckers?.[0].kinds).toContain('spelling');
    expect(result.contributes.textCheckers?.[0].disabledCategories).toEqual([]);
    expect(result.permissions).toContain('textCheckers.contribute');
  });

  it('accepts the bundled Typst manifest', () => {
    const result = validateManifest(typstManifest);
    // The plugin renders through the native `typst` binary, not a webview.
    expect(result.contributes.nativeTools).toEqual([
      expect.objectContaining({ id: 'typst', binaryName: 'typst' })
    ]);
    const render = result.contributes.noteKinds?.[0].render;
    expect(render?.requiresNativeTool).toBe('typst');
    expect(render?.previewMime).toBe('application/pdf');
    expect(render?.webview).toBeUndefined();
    expect(result.contributes.sourceLanguages).toEqual([
      expect.objectContaining({
        id: 'typst',
        provider: { type: 'host', id: 'typst' }
      })
    ]);
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

  it('accepts note exporters for built-in and plugin-owned note kinds', () => {
    const builtIn = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'notes.create',
        'noteExporters.contribute'
      ]
    });
    (builtIn.contributes as Record<string, unknown>).noteExporters = [
      {
        id: 'markdown-pdf',
        labelKey: 'export.pdf',
        noteKind: 'markdown',
        format: 'pdf',
        export: 'exportPdf'
      }
    ];
    expect(validateManifest(builtIn).contributes.noteExporters).toHaveLength(1);

    const pluginOwned = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'noteExporters.contribute',
        'notes.create'
      ]
    });
    const contributes = pluginOwned.contributes as Record<string, unknown>;
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document',
        render: { export: 'renderDocument' }
      }
    ];
    contributes.noteExporters = [
      {
        id: 'document-pdf',
        labelKey: 'export.pdf',
        noteKind: 'plugin.com.example.templates.document',
        format: 'pdf',
        export: 'exportPdf'
      }
    ];
    expect(
      validateManifest(pluginOwned).contributes.noteExporters
    ).toHaveLength(1);
  });

  it('rejects note exporters without permission or scripted runtime', () => {
    const missingPermission = validManifest({
      runtime: 'luau',
      entry: 'main.luau'
    });
    (missingPermission.contributes as Record<string, unknown>).noteExporters = [
      {
        id: 'pdf',
        labelKey: 'export.pdf',
        noteKind: 'markdown',
        format: 'pdf',
        export: 'exportPdf'
      }
    ];
    expect(() => validateManifest(missingPermission)).toThrow(
      /missing the "noteExporters.contribute"/
    );

    const manifestOnly = validManifest({
      permissions: [
        'templates.contribute',
        'notes.create',
        'noteExporters.contribute'
      ]
    });
    (manifestOnly.contributes as Record<string, unknown>).noteExporters = [
      {
        id: 'pdf',
        labelKey: 'export.pdf',
        noteKind: 'markdown',
        format: 'pdf',
        export: 'exportPdf'
      }
    ];
    expect(() => validateManifest(manifestOnly)).toThrow(
      /require runtime "luau" or "wasm"/
    );
  });

  it('rejects malformed note exporter contributions', () => {
    const base = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'notes.create',
        'noteExporters.contribute'
      ]
    });
    const contributes = base.contributes as Record<string, unknown>;
    contributes.noteExporters = [
      {
        id: 'pdf',
        labelKey: 'export.pdf',
        noteKind: 'unknown',
        format: 'pdf',
        export: 'exportPdf'
      }
    ];
    expect(() => validateManifest(base)).toThrow(/built-in note kind/);

    const badFormat = structuredClone(base);
    (
      (badFormat.contributes as Record<string, unknown>)
        .noteExporters as Record<string, unknown>[]
    )[0].noteKind = 'markdown';
    (
      (badFormat.contributes as Record<string, unknown>)
        .noteExporters as Record<string, unknown>[]
    )[0].format = 'html';
    expect(() => validateManifest(badFormat)).toThrow(/format/);
  });

  it('requires declared native tools for note exporters', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'notes.create',
        'noteExporters.contribute',
        'nativeTools.runDeclared'
      ]
    });
    (m.contributes as Record<string, unknown>).noteExporters = [
      {
        id: 'pdf',
        labelKey: 'export.pdf',
        noteKind: 'markdown',
        format: 'pdf',
        export: 'exportPdf',
        requiresNativeTool: 'typst'
      }
    ];
    expect(() => validateManifest(m)).toThrow(/undeclared native tool/);
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

  it('accepts host-owned source language contributions', () => {
    const m = withContributes((c) => {
      c.sourceLanguages = [
        {
          id: 'typst',
          labelKey: 'templates.meeting.name',
          aliases: ['typ'],
          extensions: ['typ'],
          provider: { type: 'host', id: 'typst' }
        }
      ];
    });
    expect(validateManifest(m).contributes.sourceLanguages).toHaveLength(1);
  });

  it('rejects unsafe source language contributions', () => {
    const badProvider = withContributes((c) => {
      c.sourceLanguages = [
        {
          id: 'typst',
          provider: { type: 'plugin', id: 'main' }
        }
      ];
    });
    expect(() => validateManifest(badProvider)).toThrow(/provider.type/);

    const unknownHost = withContributes((c) => {
      c.sourceLanguages = [
        {
          id: 'typst',
          provider: { type: 'host', id: 'unknown' }
        }
      ];
    });
    expect(() => validateManifest(unknownHost)).toThrow(/host source language/);

    const badExtension = withContributes((c) => {
      c.sourceLanguages = [
        {
          id: 'typst',
          extensions: ['.typ'],
          provider: { type: 'host', id: 'typst' }
        }
      ];
    });
    expect(() => validateManifest(badExtension)).toThrow(/without a dot/);
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
        viewModeLabelKeys: { wysiwyg: 'notes.document.label' },
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

  it('accepts a preview service and a note kind that uses it', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeServices.run'
      ]
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.nativeServices = [
      {
        id: 'tinymist',
        binaryName: 'tinymist',
        args: ['preview', '127.0.0.1:{dataPort}', '{input}'],
        dataUrl: 'http://127.0.0.1:{dataPort}',
        controlUrl: 'ws://127.0.0.1:{controlPort}',
        previewIframe: { mode: 'themed', css: 'preview.css' },
        protocol: { jumpEvent: 'editorScrollTo' }
      }
    ];
    contributes.noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          previewMime: 'application/pdf',
          previewService: 'tinymist'
        }
      }
    ];
    expect(
      validateManifest(m).contributes.noteKinds?.[0].render.previewService
    ).toBe('tinymist');
    expect(
      validateManifest(m).contributes.nativeServices?.[0].previewIframe
    ).toEqual({ mode: 'themed', css: 'preview.css' });
  });

  it('rejects unsafe preview service iframe css paths', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeServices.run'
      ]
    });
    (m.contributes as Record<string, unknown>).nativeServices = [
      {
        id: 'tinymist',
        binaryName: 'tinymist',
        args: ['preview', '{input}'],
        dataUrl: 'http://127.0.0.1:{dataPort}',
        controlUrl: 'ws://127.0.0.1:{controlPort}',
        previewIframe: { mode: 'themed', css: '../preview.css' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/safe relative .css path/);
  });

  it('rejects preview service iframe css on direct mode', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeServices.run'
      ]
    });
    (m.contributes as Record<string, unknown>).nativeServices = [
      {
        id: 'tinymist',
        binaryName: 'tinymist',
        args: ['preview', '{input}'],
        dataUrl: 'http://127.0.0.1:{dataPort}',
        controlUrl: 'ws://127.0.0.1:{controlPort}',
        previewIframe: { mode: 'direct', css: 'preview.css' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/only allowed/);
  });

  it('rejects a preview service whose iframe URL is not loopback', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeServices.run'
      ]
    });
    (m.contributes as Record<string, unknown>).nativeServices = [
      {
        id: 'evil',
        binaryName: 'tinymist',
        args: ['{input}'],
        // Points the note preview iframe at an arbitrary remote origin.
        dataUrl: 'http://evil.example.com:{dataPort}',
        controlUrl: 'ws://127.0.0.1:{controlPort}'
      }
    ];
    expect(() => validateManifest(m)).toThrow(/dataUrl must be a loopback/);
  });

  it('rejects previewService for an undeclared service', () => {
    const m = validManifest({
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create',
        'nativeServices.run'
      ]
    });
    (m.contributes as Record<string, unknown>).noteKinds = [
      {
        id: 'document',
        labelKey: 'notes.document.label',
        render: {
          export: 'renderDocument',
          previewMime: 'application/pdf',
          previewService: 'ghost'
        }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/undeclared native service/);
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

  it('rejects unknown plugin note kind view mode label keys', () => {
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
        viewModeLabelKeys: { preview: 'notes.document.label' },
        render: { export: 'renderDocument', previewMime: 'text/html' }
      }
    ];
    expect(() => validateManifest(m)).toThrow(/viewModeLabelKeys.preview/);
  });

  it('rejects plugin setting option labels for undeclared options', () => {
    const m = validManifest({
      permissions: ['templates.contribute', 'notes.create']
    });
    const contributes = m.contributes as Record<string, unknown>;
    contributes.settings = [
      {
        sectionId: 'editor',
        titleKey: 'settings.editor.title',
        settings: [
          {
            id: 'mode',
            labelKey: 'settings.defaultMode.label',
            scope: 'D',
            type: 'select',
            default: 'source',
            options: ['source'],
            optionLabelKeys: {
              wysiwyg: 'settings.defaultMode.preview'
            }
          }
        ]
      }
    ];
    expect(() => validateManifest(m)).toThrow(
      /must match one of the setting options/
    );
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

/** Mutate the first setting of the base manifest, then validate. */
function withSetting(
  mutate: (s: Record<string, unknown>) => void
): Record<string, unknown> {
  return withContributes((c) => {
    const s = (c.settings as Record<string, unknown>[])[0] as {
      settings: Record<string, unknown>[];
    };
    mutate(s.settings[0]);
  });
}

/** Mutate the first note template of the base manifest, then validate. */
function withTemplate(
  mutate: (t: Record<string, unknown>) => void
): Record<string, unknown> {
  return withContributes((c) => {
    mutate((c.noteTemplates as Record<string, unknown>[])[0]);
  });
}

/** A scripted (luau) manifest carrying the given extra contributions. */
function scripted(
  contributes: Record<string, unknown>,
  permissions: string[] = []
): Record<string, unknown> {
  return {
    id: 'com.example.scripted',
    name: 'Scripted',
    version: '1.0.0',
    runtime: 'luau',
    entry: 'main.luau',
    permissions,
    contributes: { i18n: { en: { 'k.label': 'K' } }, ...contributes }
  };
}

describe('validateManifest — setting failures', () => {
  it('rejects an invalid scope', () => {
    expect(() => validateManifest(withSetting((s) => (s.scope = 'X')))).toThrow(
      /scope must be/
    );
  });
  it('rejects an unsupported setting type', () => {
    expect(() =>
      validateManifest(withSetting((s) => (s.type = 'hologram')))
    ).toThrow(/not a supported setting type/);
  });
  it('rejects a select with no options', () => {
    expect(() =>
      validateManifest(
        withSetting((s) => {
          s.type = 'select';
          delete s.options;
        })
      )
    ).toThrow(/must list at least one option/);
  });
  it('rejects a non-object optionLabelKeys', () => {
    expect(() =>
      validateManifest(
        withSetting((s) => {
          s.type = 'select';
          s.options = ['a'];
          s.optionLabelKeys = 'nope';
        })
      )
    ).toThrow(/optionLabelKeys must be an object/);
  });
  it('rejects optionLabelKeys that do not match an option', () => {
    expect(() =>
      validateManifest(
        withSetting((s) => {
          s.type = 'select';
          s.options = ['a'];
          s.optionLabelKeys = { b: 'settings.x.label' };
        })
      )
    ).toThrow(/must match one of the setting options/);
  });
  it('rejects a bad setting descriptionKey', () => {
    expect(() =>
      validateManifest(withSetting((s) => (s.descriptionKey = 'Bad Key!')))
    ).toThrow(/not a valid i18n key/);
  });
  it('rejects an empty settings array in a section', () => {
    expect(() =>
      validateManifest(
        withContributes((c) => {
          (c.settings as Record<string, unknown>[])[0].settings = [];
        })
      )
    ).toThrow(/must be a non-empty array/);
  });
  it('rejects a duplicate setting id across sections', () => {
    expect(() =>
      validateManifest(
        withContributes((c) => {
          const sections = c.settings as Record<string, unknown>[];
          sections.push({
            sectionId: 'other',
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
          });
        })
      )
    ).toThrow(/duplicate setting id/);
  });
});

describe('validateManifest — template + variable failures', () => {
  it('rejects a non-kebab template id', () => {
    expect(() => validateManifest(withTemplate((t) => (t.id = 'Bad')))).toThrow(
      /kebab-case slug/
    );
  });
  it('rejects a malformed template labelKey', () => {
    expect(() =>
      validateManifest(withTemplate((t) => (t.labelKey = 'Bad Key')))
    ).toThrow(/not a valid i18n key/);
  });
  it('rejects a bad template descriptionKey', () => {
    expect(() =>
      validateManifest(withTemplate((t) => (t.descriptionKey = 'Bad!')))
    ).toThrow(/not a valid i18n key/);
  });
  it('rejects a render export name with illegal characters', () => {
    expect(() =>
      validateManifest(withTemplate((t) => (t.render = 'bad name')))
    ).toThrow(/backend script export name/);
  });
  it('rejects a non-string bodyTemplate', () => {
    expect(() =>
      validateManifest(withTemplate((t) => (t.bodyTemplate = 5)))
    ).toThrow(/bodyTemplate must be a string/);
  });
  it('rejects an unsupported variable type', () => {
    expect(() =>
      validateManifest(
        withTemplate((t) => {
          t.variables = [
            { id: 'a', labelKey: 'templates.meeting.name', type: 'bogus' }
          ];
        })
      )
    ).toThrow(/not a supported variable type/);
  });
  it('rejects a non-string variable default', () => {
    expect(() =>
      validateManifest(
        withTemplate((t) => {
          t.variables = [
            {
              id: 'a',
              labelKey: 'templates.meeting.name',
              type: 'text',
              default: 5
            }
          ];
        })
      )
    ).toThrow(/default must be a string/);
  });
  it('rejects a duplicated variable id', () => {
    expect(() =>
      validateManifest(
        withTemplate((t) => {
          t.variables = [
            { id: 'a', labelKey: 'templates.meeting.name', type: 'text' },
            { id: 'a', labelKey: 'templates.meeting.name', type: 'text' }
          ];
        })
      )
    ).toThrow(/more than once/);
  });
});

describe('validateManifest — source language failures', () => {
  const base = (language: unknown) => scripted({ sourceLanguages: [language] });
  it('rejects a malformed language id', () => {
    expect(() =>
      validateManifest(
        base({ id: 'bad!', provider: { type: 'host', id: 'typst' } })
      )
    ).toThrow(/short source language identifier/);
  });
  it('rejects non-array aliases', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          aliases: 'x',
          provider: { type: 'host', id: 'typst' }
        })
      )
    ).toThrow(/aliases must be an array/);
  });
  it('rejects a malformed alias', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          aliases: ['bad!'],
          provider: { type: 'host', id: 'typst' }
        })
      )
    ).toThrow(/short source language identifier/);
  });
  it('rejects non-array extensions', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          extensions: 'x',
          provider: { type: 'host', id: 'typst' }
        })
      )
    ).toThrow(/extensions must be an array/);
  });
  it('rejects a diagnostics syntax the app does not ship', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { syntax: 'latex' }
        })
      )
    ).toThrow(/is not a syntax the app ships/);
  });
  it('rejects a non-object diagnostics block', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          provider: { type: 'host', id: 'typst' },
          diagnostics: 'typst'
        })
      )
    ).toThrow(/diagnostics must be an object/);
  });
  it('accepts a diagnostics syntax the app ships', () => {
    const manifest = validateManifest(
      base({
        id: 'ts',
        provider: { type: 'host', id: 'typst' },
        diagnostics: { syntax: 'typst' }
      })
    );
    expect(manifest.contributes.sourceLanguages?.[0].diagnostics).toEqual({
      syntax: 'typst'
    });
  });
  it('rejects setting neither syntax nor grammar', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          provider: { type: 'host', id: 'typst' },
          diagnostics: {}
        })
      )
    ).toThrow(/exactly one of syntax or grammar/);
  });
  it('rejects setting both syntax and grammar', () => {
    // Two answers to one question; the host would have to guess, and guessing
    // means checking a document by rules its author did not choose.
    expect(() =>
      validateManifest(
        base({
          id: 'ts',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { syntax: 'typst', grammar: { lineComments: ['%'] } }
        })
      )
    ).toThrow(/exactly one of syntax or grammar/);
  });
  it('accepts a declared grammar', () => {
    const manifest = validateManifest(
      base({
        id: 'tex',
        provider: { type: 'host', id: 'typst' },
        diagnostics: {
          grammar: {
            lineComments: ['%'],
            math: [['$', '$']],
            escape: '\\',
            indentation: true
          }
        }
      })
    );
    expect(
      manifest.contributes.sourceLanguages?.[0].diagnostics?.grammar?.escape
    ).toBe('\\');
  });
  it('rejects a delimiter pair that is not a pair', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'tex',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { grammar: { math: [['$']] } }
        })
      )
    ).toThrow(/must be an \[open, close\] pair/);
  });
  it('rejects a multi-character escape', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'tex',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { grammar: { escape: '<<' } }
        })
      )
    ).toThrow(/must be a single character/);
  });
  it('bounds how many delimiters a grammar may declare', () => {
    // The scanner runs on every keystroke; the cap is what keeps that cost
    // flat no matter what a manifest asks for.
    expect(() =>
      validateManifest(
        base({
          id: 'tex',
          provider: { type: 'host', id: 'typst' },
          diagnostics: {
            grammar: { lineComments: Array.from({ length: 25 }, () => '%') }
          }
        })
      )
    ).toThrow(/at most 24 entries/);
  });
  it('bounds how long a single delimiter may be', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'tex',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { grammar: { lineComments: ['x'.repeat(33)] } }
        })
      )
    ).toThrow(/at most 32 characters/);
  });
  it('rejects a non-boolean grammar flag', () => {
    expect(() =>
      validateManifest(
        base({
          id: 'tex',
          provider: { type: 'host', id: 'typst' },
          diagnostics: { grammar: { indentation: 'yes' } }
        })
      )
    ).toThrow(/indentation must be a boolean/);
  });
  it('rejects a non-object provider', () => {
    expect(() => validateManifest(base({ id: 'ts', provider: 'x' }))).toThrow(
      /provider must be an object/
    );
  });
  it('rejects a non-host provider type', () => {
    expect(() =>
      validateManifest(
        base({ id: 'ts', provider: { type: 'guest', id: 'typst' } })
      )
    ).toThrow(/provider.type must be "host"/);
  });
  it('rejects an unsupported host provider id', () => {
    expect(() =>
      validateManifest(
        base({ id: 'ts', provider: { type: 'host', id: 'nope' } })
      )
    ).toThrow(/not a supported host source language provider/);
  });
});

describe('validateManifest — artifact failures', () => {
  const artifact = (a: Record<string, unknown>) => scripted({ artifacts: [a] });
  const good = {
    id: 'compiler',
    kind: 'wasm',
    version: '1.0.0',
    url: 'https://example.com/x.wasm',
    sha256: 'a'.repeat(64),
    fileName: 'x.wasm'
  };
  it('rejects an unsupported artifact kind', () => {
    expect(() =>
      validateManifest(artifact({ ...good, kind: 'floppy' }))
    ).toThrow(/kind .* is not supported/);
  });
  it('rejects an unparseable url', () => {
    expect(() =>
      validateManifest(artifact({ ...good, url: 'not a url' }))
    ).toThrow(/must be a valid URL/);
  });
  it('rejects a non-HTTPS url', () => {
    expect(() =>
      validateManifest(artifact({ ...good, url: 'http://example.com/x.wasm' }))
    ).toThrow(/must use HTTPS/);
  });
  it('rejects a non-hex sha256', () => {
    expect(() =>
      validateManifest(artifact({ ...good, sha256: 'ZZZ' }))
    ).toThrow(/lowercase SHA-256 hex digest/);
  });
  it('rejects a path-bearing fileName', () => {
    expect(() =>
      validateManifest(artifact({ ...good, fileName: 'a/b.wasm' }))
    ).toThrow(/safe filename without path separators/);
  });
  it('rejects a non-positive sizeBytes', () => {
    expect(() => validateManifest(artifact({ ...good, sizeBytes: 0 }))).toThrow(
      /positive finite number/
    );
  });
});

describe('validateManifest — native tool + service failures', () => {
  it('rejects a native tool binary with a path separator', () => {
    expect(() =>
      validateManifest(
        scripted({ nativeTools: [{ id: 'typst', binaryName: 'bin/typst' }] }, [
          'nativeTools.runDeclared'
        ])
      )
    ).toThrow(/executable basename resolved from PATH/);
  });

  const service = (s: Record<string, unknown>) =>
    scripted({ nativeServices: [s] }, ['nativeServices.run']);
  const goodService = {
    id: 'preview',
    binaryName: 'tinymist',
    args: ['preview', '{input}'],
    dataUrl: 'http://127.0.0.1:{dataPort}',
    controlUrl: 'ws://127.0.0.1:{controlPort}'
  };
  it('rejects non-array service args', () => {
    expect(() =>
      validateManifest(service({ ...goodService, args: 'x' }))
    ).toThrow(/args must be an array/);
  });
  it('rejects a non-loopback dataUrl', () => {
    expect(() =>
      validateManifest(service({ ...goodService, dataUrl: 'http://evil.com' }))
    ).toThrow(/loopback http URL template/);
  });
  it('rejects a non-loopback controlUrl', () => {
    expect(() =>
      validateManifest(
        service({ ...goodService, controlUrl: 'wss://evil.com' })
      )
    ).toThrow(/loopback ws URL template/);
  });
  it('rejects a bad inputExtension', () => {
    expect(() =>
      validateManifest(
        service({ ...goodService, inputExtension: 'not/an/ext' })
      )
    ).toThrow(/short alphanumeric extension/);
  });
  it('rejects a previewIframe with an invalid mode', () => {
    expect(() =>
      validateManifest(
        service({ ...goodService, previewIframe: { mode: 'floating' } })
      )
    ).toThrow(/mode must be "direct" or "themed"/);
  });
  it('rejects previewIframe css when mode is not themed', () => {
    expect(() =>
      validateManifest(
        service({
          ...goodService,
          previewIframe: { mode: 'direct', css: 'preview.css' }
        })
      )
    ).toThrow(/css is only allowed when mode is "themed"/);
  });
  it('accepts a themed previewIframe socketRewritePort', () => {
    const m = validateManifest(
      service({
        ...goodService,
        previewIframe: { mode: 'themed', socketRewritePort: 23625 }
      })
    );
    expect(
      m.contributes.nativeServices?.[0].previewIframe?.socketRewritePort
    ).toBe(23625);
  });
  it('rejects socketRewritePort when mode is not themed', () => {
    expect(() =>
      validateManifest(
        service({
          ...goodService,
          previewIframe: { mode: 'direct', socketRewritePort: 23625 }
        })
      )
    ).toThrow(/socketRewritePort is only allowed when mode is "themed"/);
  });
  it('rejects an out-of-range socketRewritePort', () => {
    expect(() =>
      validateManifest(
        service({
          ...goodService,
          previewIframe: { mode: 'themed', socketRewritePort: 70000 }
        })
      )
    ).toThrow(/socketRewritePort must be an integer between 1 and 65535/);
  });
});

describe('validateManifest — note kind render failures', () => {
  const noteKind = (render: unknown, permissions = ['noteKinds.contribute']) =>
    scripted(
      { noteKinds: [{ id: 'doc', labelKey: 'k.label', render }] },
      permissions
    );
  it('rejects a bad render export name', () => {
    expect(() => validateManifest(noteKind({ export: 'bad name' }))).toThrow(
      /backend script export name/
    );
  });
  it('rejects requiresNativeTool referencing an undeclared tool', () => {
    expect(() =>
      validateManifest(
        noteKind({ export: 'render', requiresNativeTool: 'ghost' }, [
          'noteKinds.contribute',
          'nativeTools.runDeclared'
        ])
      )
    ).toThrow(/undeclared native tool/);
  });
  it('rejects an unsupported previewMime', () => {
    expect(() =>
      validateManifest(noteKind({ export: 'render', previewMime: 'text/rtf' }))
    ).toThrow(/previewMime .* is not supported/);
  });
  it('rejects a negative debounceMs', () => {
    expect(() =>
      validateManifest(noteKind({ export: 'render', debounceMs: -5 }))
    ).toThrow(/non-negative finite number/);
  });
  it('rejects a webview entry outside the plugin dir', () => {
    expect(() =>
      validateManifest(
        noteKind({ export: 'render', webview: { entry: '../evil.js' } })
      )
    ).toThrow(/safe relative .js\/.mjs path/);
  });
  it('rejects a non-string requiresNativeTool', () => {
    expect(() =>
      validateManifest(noteKind({ export: 'render', requiresNativeTool: 5 }))
    ).toThrow(/requiresNativeTool must be a string/);
  });
  it('rejects a non-object webview', () => {
    expect(() =>
      validateManifest(noteKind({ export: 'render', webview: 'x' }))
    ).toThrow(/webview must be an object/);
  });
  it('rejects a non-boolean webview allowEval', () => {
    expect(() =>
      validateManifest(
        noteKind({
          export: 'render',
          webview: { entry: 'ui.js', allowEval: 'x' }
        })
      )
    ).toThrow(/allowEval must be a boolean/);
  });
});

describe('validateManifest — note kind field + exporter failures', () => {
  const noteKindWith = (extra: Record<string, unknown>) =>
    scripted(
      {
        noteKinds: [
          { id: 'doc', labelKey: 'k.label', render: { export: 'r' }, ...extra }
        ]
      },
      ['noteKinds.contribute']
    );
  it('rejects an unsafe icon path', () => {
    expect(() => validateManifest(noteKindWith({ icon: '../x.svg' }))).toThrow(
      /safe relative .svg path/
    );
  });
  it('rejects a malformed sourceLanguage id', () => {
    expect(() =>
      validateManifest(noteKindWith({ sourceLanguage: 'bad!' }))
    ).toThrow(/short language identifier/);
  });
  it('rejects a non-object viewModeLabelKeys', () => {
    expect(() =>
      validateManifest(noteKindWith({ viewModeLabelKeys: 'x' }))
    ).toThrow(/viewModeLabelKeys must be an object/);
  });
  it('rejects a non-string defaultTitle', () => {
    expect(() => validateManifest(noteKindWith({ defaultTitle: 5 }))).toThrow(
      /defaultTitle must be a string/
    );
  });
  it('rejects a non-string defaultBody', () => {
    expect(() => validateManifest(noteKindWith({ defaultBody: 5 }))).toThrow(
      /defaultBody must be a string/
    );
  });

  const exporter = (e: Record<string, unknown>) =>
    scripted({ noteExporters: [e] }, ['noteExporters.contribute']);
  const goodExporter = {
    id: 'pdf',
    labelKey: 'k.label',
    noteKind: 'markdown',
    format: 'pdf',
    export: 'exportPdf'
  };
  it('rejects an exporter with a bad export name', () => {
    expect(() =>
      validateManifest(exporter({ ...goodExporter, export: 'bad name' }))
    ).toThrow(/backend script export name/);
  });
  it('rejects an exporter with an unsupported format', () => {
    expect(() =>
      validateManifest(exporter({ ...goodExporter, format: 'docx' }))
    ).toThrow(/format .* is not supported/);
  });
  it('rejects an exporter for an unknown note kind', () => {
    expect(() =>
      validateManifest(exporter({ ...goodExporter, noteKind: 'mystery' }))
    ).toThrow(/must be a built-in note kind/);
  });
});
