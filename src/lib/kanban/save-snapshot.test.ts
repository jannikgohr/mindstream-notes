import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { captureKanbanSave } from './save-snapshot';
import { readBoardFromYDoc, writeBoardToYDoc } from './kanban-yjs';

const render = vi.hoisted(() => vi.fn());
vi.mock('./description-markdown', () => ({ renderKanbanDescription: render }));

describe('Kanban save snapshot', () => {
  it('captures before rendering and survives destruction of the live document', async () => {
    let complete!: (html: string) => void;
    render.mockReturnValue(
      new Promise<string>((resolve) => {
        complete = resolve;
      })
    );
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, {
      columns: [],
      cards: [
        {
          id: 'card',
          label: 'First',
          description: 'before',
          column: 'todo',
          order: 0
        }
      ]
    });
    const save = captureKanbanSave(doc);
    writeBoardToYDoc(doc, {
      columns: [],
      cards: [
        {
          id: 'card',
          label: 'Second',
          description: 'after',
          column: 'todo',
          order: 0
        }
      ]
    });
    doc.destroy();
    const saving = save();
    complete('<p>before</p>');
    const saved = await saving;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(saved.yrs_state));
    expect(readBoardFromYDoc(restored).cards[0]).toMatchObject({
      label: 'First',
      description: 'before',
      descriptionHtml: '<p>before</p>'
    });
    expect(readBoardFromYDoc(doc).cards[0].label).toBe('Second');
    expect(saved.body).toContain('before');
    expect(saved.body).not.toContain('after');
    restored.destroy();
  });

  it('propagates rendering failures to the save scheduler', async () => {
    render.mockRejectedValue(new Error('renderer unavailable'));
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, {
      columns: [],
      cards: [
        {
          id: 'card',
          label: 'First',
          description: 'body',
          column: 'todo',
          order: 0
        }
      ]
    });
    await expect(captureKanbanSave(doc)()).rejects.toThrow(
      'renderer unavailable'
    );
    doc.destroy();
  });
});
