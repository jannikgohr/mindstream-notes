/** Must run before loading Excalidraw, which registers font URLs on import. */
if (typeof window !== 'undefined') {
  const assetsWindow = window as Window & {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  };
  assetsWindow.EXCALIDRAW_ASSET_PATH ??= new URL(
    `${import.meta.env.BASE_URL}excalidraw/`,
    window.location.href
  ).href;
}
