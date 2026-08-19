/**
 * The messages crossing the Worker boundary.
 *
 * Its own module so the Worker and its host share one definition without the
 * host importing the Worker's entry point (which would run it on the main
 * thread) or the Worker importing the host's (which would drag in the DOM).
 */

import type { TextRange } from '../types';
import type { DiagnosticGrammar } from './grammar';

export interface GrammarRequest {
  /** Correlates a reply with its request; the Worker handles them in order. */
  id: number;
  grammar: DiagnosticGrammar;
  text: string;
}

export type GrammarResponse =
  | { id: number; ranges: TextRange[]; error?: undefined }
  | { id: number; ranges?: undefined; error: string };
