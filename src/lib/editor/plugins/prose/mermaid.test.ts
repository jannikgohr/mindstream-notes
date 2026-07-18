import { describe, expect, it } from 'vitest';
import { mermaidLanguageDescription, renderMermaidPreview } from './mermaid';

describe('mermaidLanguageDescription', () => {
  // Regression: the original no-op token (`() => null`) never advanced
  // the stream, so CodeMirror threw "Stream parser failed to advance
  // stream." on every highlight pass — which broke typing inside
  // mermaid code blocks entirely.
  it('parses content without throwing (token must advance the stream)', () => {
    const language = mermaidLanguageDescription.support!.language;
    const doc = 'graph TD\n  A-->B\n  B-->C';
    const tree = language.parser.parse(doc);
    expect(tree.length).toBe(doc.length);
  });

  it('is discoverable under the mermaid name and mmd alias', () => {
    expect(mermaidLanguageDescription.name).toBe('Mermaid');
    expect(mermaidLanguageDescription.alias).toContain('mmd');
  });
});

describe('renderMermaidPreview', () => {
  it('falls through for other languages', () => {
    expect(renderMermaidPreview('javascript', 'graph TD', () => {})).toBeNull();
  });

  it('skips empty fences so the user can type the first line in peace', () => {
    expect(renderMermaidPreview('mermaid', '   \n ', () => {})).toBeNull();
  });

  it('returns a placeholder for mermaid content, case-insensitively', () => {
    expect(
      renderMermaidPreview('Mermaid', 'graph TD', () => {})
    ).toBeInstanceOf(HTMLElement);
    expect(
      renderMermaidPreview('mermaid', 'graph TD', () => {})
    ).toBeInstanceOf(HTMLElement);
  });
});
