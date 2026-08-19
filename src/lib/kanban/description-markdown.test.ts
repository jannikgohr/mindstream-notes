import { describe, expect, it } from 'vitest';
import { renderKanbanDescription } from './description-markdown';

describe('renderKanbanDescription', () => {
  it('renders compact Markdown while demoting headings', async () => {
    await expect(
      renderKanbanDescription('# **Plan**\n\n- first\n- second')
    ).resolves.toBe(
      '<p><strong>Plan</strong></p><ul><li><p>first</p></li><li><p>second</p></li></ul>'
    );
  });

  it('escapes HTML and drops unsafe link protocols', async () => {
    const html = await renderKanbanDescription(
      '<img src=x> [safe](https://example.com) [bad](javascript:alert(1))'
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:');
  });
});
