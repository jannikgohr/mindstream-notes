import { afterEach, describe, expect, it } from 'vitest';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled
} from '$lib/plugins/registry.svelte';
import { sourceLanguageExtensions } from './languages';

function typstLanguageManifest(): Record<string, unknown> {
  return {
    id: 'com.example.typst',
    name: 'Typst',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: [],
    contributes: {
      sourceLanguages: [
        {
          id: 'typst',
          aliases: ['typ'],
          extensions: ['typ'],
          provider: { type: 'host', id: 'typst' }
        }
      ]
    }
  };
}

afterEach(() => resetPluginRegistry());

describe('sourceLanguageExtensions', () => {
  it('always provides built-in markdown support', () => {
    expect(sourceLanguageExtensions('markdown')).not.toHaveLength(0);
  });

  it('keeps plugin languages plain text until an enabled plugin contributes them', () => {
    expect(sourceLanguageExtensions('typst')).toHaveLength(0);
    registerPlugin(typstLanguageManifest());
    expect(sourceLanguageExtensions('typst')).not.toHaveLength(0);
    expect(sourceLanguageExtensions('typ')).not.toHaveLength(0);
  });

  it('removes plugin language support when the owning plugin is disabled', () => {
    registerPlugin(typstLanguageManifest());
    setPluginEnabled('com.example.typst', false);
    expect(sourceLanguageExtensions('typst')).toHaveLength(0);
  });
});
