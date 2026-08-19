import { describe, expect, it } from 'vitest';
import { renderKanbanDescription } from './description-markdown';

describe('renderKanbanDescription', () => {
  it('renders compact Markdown while demoting headings', () => {
    expect(renderKanbanDescription('# **Plan**\n\n- first\n- second')).toBe(
      '<p><strong>Plan</strong></p><ul><li>first</li><li>second</li></ul>'
    );
  });

  it('escapes HTML and drops unsafe link protocols', () => {
    const html = renderKanbanDescription(
      '<img src=x> [safe](https://example.com) [bad](javascript:alert(1))'
    );
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:');
  });
});
