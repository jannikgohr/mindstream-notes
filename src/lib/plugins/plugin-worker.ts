/**
 * Runs bundled plugin calls off the page thread, so `plugin-runner.ts` can
 * terminate one that overruns. It must import nothing that touches the DOM,
 * Svelte or app state.
 */

import { handlePluginRequest, type PluginRequest } from './browser-runtime';

self.onmessage = (event: MessageEvent<PluginRequest>) =>
  handlePluginRequest(event.data, (response) => self.postMessage(response));
