(() => {
  if (location.pathname !== '/legacy-browser-export.html') return;
  let values = Object.create(null);
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) throw new Error('Storage changed during export');
      const value = localStorage.getItem(key);
      if (value === null) throw new Error('Storage changed during export');
      values[key] = value;
    }
  } catch {
    values = null;
  }
  const origin = `${location.protocol}//${location.host}`;
  const exportReady = () => {
    window.__TAURI_INTERNALS__
      .invoke('finish_legacy_browser_export', { origin, values })
      .catch(() => {
        document.getElementById('status').textContent =
          'Browser migration could not finish. Your original data is retained. Close and reopen Mindstream Notes to retry.';
      });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', exportReady, { once: true });
  } else {
    exportReady();
  }
})();
