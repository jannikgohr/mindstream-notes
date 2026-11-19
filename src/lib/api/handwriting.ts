/** Handwriting recognition API. Mirror of src-tauri/src/handwriting.rs. */

import { assertString, TauriCommandName, invokeOrFallback } from './core';

export function recognizeHandwriting(
  endpoint: string,
  model: string,
  apiKey: string,
  image: string
): Promise<string> {
  return invokeOrFallback<string>(
    TauriCommandName.HandwritingRecognize,
    { endpoint, model, apiKey: apiKey || null, image },
    () => {
      throw new Error(
        'Handwriting recognition needs the desktop or mobile app'
      );
    },
    (value) => assertString(value, 'handwriting_recognize response')
  );
}
