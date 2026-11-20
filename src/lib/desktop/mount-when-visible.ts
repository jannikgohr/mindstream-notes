interface PanelVisibility {
  readonly isVisible: boolean;
  onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void): {
    dispose(): void;
  };
}

/**
 * Mount a dock panel's content the first time it is on screen.
 *
 * A restored layout creates every tab's panel at once, and a mounted editor
 * keeps its document, editor state and timers for as long as the tab exists.
 * Dockview reports a panel as visible until its group has placed it, and a
 * restore briefly activates panels in turn, so visibility is only trusted
 * once the current synchronous work has finished.
 */
export function mountWhenFirstVisible(
  api: PanelVisibility,
  mount: () => void
): () => void {
  let settled = false;
  let checkQueued = false;
  const check = () => {
    if (checkQueued) return;
    checkQueued = true;
    queueMicrotask(() => {
      checkQueued = false;
      if (settled || !api.isVisible) return;
      stop();
      mount();
    });
  };
  const subscription = api.onDidVisibilityChange(check);
  const stop = () => {
    settled = true;
    subscription.dispose();
  };
  check();
  return stop;
}
