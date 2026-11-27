import { describe, expect, it } from 'vitest';
import { dropDoesNothing, type DockOverlayEvent } from './dock-drop-overlay';

const VIEW = 'view-1';

function overlay(
  over: Partial<DockOverlayEvent> & {
    groupPanels?: string[];
    data?: {
      viewId?: string;
      groupId: string;
      panelId: string | null;
      tabGroupId?: string;
    };
  }
): DockOverlayEvent {
  const { groupPanels = ['a', 'b'], data, ...rest } = over;
  return {
    kind: 'content',
    position: 'center',
    edge: false,
    group: { id: 'g1', panels: groupPanels.map((id) => ({ id })) },
    getData: () => (data ? { viewId: VIEW, ...data } : undefined),
    ...rest
  };
}

describe('dropDoesNothing', () => {
  it('flags a tab dropped on the centre of its own group', () => {
    const event = overlay({ data: { groupId: 'g1', panelId: 'a' } });
    expect(dropDoesNothing(event, VIEW)).toBe(true);
  });

  it('flags a group’s only tab dropped anywhere on its own group', () => {
    for (const position of [
      'center',
      'left',
      'right',
      'top',
      'bottom'
    ] as const) {
      const event = overlay({
        position,
        groupPanels: ['a'],
        data: { groupId: 'g1', panelId: 'a' }
      });
      expect(dropDoesNothing(event, VIEW)).toBe(true);
    }
  });

  it('flags a whole group dropped on itself', () => {
    const event = overlay({
      position: 'left',
      data: { groupId: 'g1', panelId: null }
    });
    expect(dropDoesNothing(event, VIEW)).toBe(true);
  });

  it('keeps a split of a tab off a group with other tabs', () => {
    const event = overlay({
      position: 'right',
      data: { groupId: 'g1', panelId: 'a' }
    });
    expect(dropDoesNothing(event, VIEW)).toBe(false);
  });

  it('keeps a move into another group', () => {
    const event = overlay({
      groupPanels: ['c'],
      data: { groupId: 'g2', panelId: 'a' }
    });
    expect(dropDoesNothing(event, VIEW)).toBe(false);
  });

  it('keeps a whole group dropped on another group', () => {
    const event = overlay({ data: { groupId: 'g2', panelId: null } });
    expect(dropDoesNothing(event, VIEW)).toBe(false);
  });

  it('keeps a tab group moved to an edge of its own group', () => {
    const event = overlay({
      position: 'left',
      data: { groupId: 'g1', panelId: null, tabGroupId: 't1' }
    });
    expect(dropDoesNothing(event, VIEW)).toBe(false);
  });

  it('keeps layout-edge cells, which dock to the whole layout', () => {
    const event = overlay({
      position: 'left',
      edge: true,
      groupPanels: ['a'],
      data: { groupId: 'g1', panelId: 'a' }
    });
    expect(dropDoesNothing(event, VIEW)).toBe(false);
  });

  it('leaves tab-strip and foreign drags alone', () => {
    const own = { groupId: 'g1', panelId: 'a' };
    expect(dropDoesNothing(overlay({ kind: 'tab', data: own }), VIEW)).toBe(
      false
    );
    expect(
      dropDoesNothing(overlay({ data: { ...own, viewId: 'other-view' } }), VIEW)
    ).toBe(false);
    expect(dropDoesNothing(overlay({}), VIEW)).toBe(false);
  });
});
