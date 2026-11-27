import type { DockviewWillShowOverlayLocationEvent } from 'dockview';

export type DockOverlayEvent = Pick<
  DockviewWillShowOverlayLocationEvent,
  'kind' | 'position' | 'edge'
> & {
  group: { id: string; panels: readonly { id: string }[] } | undefined;
  getData(): ReturnType<DockviewWillShowOverlayLocationEvent['getData']>;
};

/**
 * Whether dockview would ignore a drop on this content overlay. Dockview tints
 * every drop zone of a drag from its own view, but `handleDropEvent` (in
 * DockviewGroupPanelModel, dockview-core 8.2) then returns early for these.
 */
export function dropDoesNothing(event: DockOverlayEvent, viewId: string) {
  if (event.kind !== 'content' || event.edge || !event.group) return false;
  const data = event.getData();
  if (data?.viewId !== viewId) return false;
  const ownGroup = data.groupId === event.group.id;
  if (ownGroup && event.position === 'center') return true;
  if (data.panelId === null) return ownGroup && !data.tabGroupId;
  const { panels } = event.group;
  return panels.length === 1 && panels[0].id === data.panelId;
}
