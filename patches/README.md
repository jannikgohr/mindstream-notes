# Bits UI focus-scope cleanup

`bits-ui@1.0.0-next.78.patch` prevents a delayed cleanup from removing a
focus scope that has since registered again. It preserves cleanup on a real
close. Keep the patch until a dependency upgrade passes the importer focus
regression without it.

The importer reproduces the problem when source detection changes its content
from source selection to configuration while Settings remains open. The focus
scope registers again before the previous cleanup's zero-delay callback runs.
That callback removes the live importer scope and resumes Settings, leaving
both dialogs' event handlers trapping focus. Focusing an import field then
bounces between the two dialogs.

The native CI run at commit `7738a6b9` hung inside the unresolved-links field
setter, before Import was clicked. Independent X11 screenshots showed the
configuration screen frozen until session teardown. Browser tracing reproduced
the registration/cleanup sequence and recursive focus calls. Suppressing only
stale cleanup reduced the two field operations to two focus calls in WebKit.

`e2e-tests/browser/import-notes.spec.ts` covers configuration field focus,
returning to Settings, and reopening the importer in Chromium and WebKit.
The packaged-app suite continues to verify the real import.
