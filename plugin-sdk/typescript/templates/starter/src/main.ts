import { clock, definePlugin } from '@mindstream/plugin-sdk';
import type { Context, Effect } from '@mindstream/plugin-sdk';

/**
 * The toolbar button's export. It computes; the app acts: the returned
 * effect is what the app inserts into the open note.
 */
function insertToday(ctx: Context): Effect {
  const today = clock.today('dddd, D MMMM YYYY', 0, ctx.locale);
  return { effect: 'insertMarkdown', markdown: today };
}

export const invoke = definePlugin({ insertToday });
