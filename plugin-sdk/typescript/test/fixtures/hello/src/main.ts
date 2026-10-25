import {
  clock,
  definePlugin,
  HostError,
  nativeTools,
  notes,
  storage
} from '@mindstream/plugin-sdk';
import type { Context, Effect } from '@mindstream/plugin-sdk';
import { shout } from './shout';

function greet(ctx: Context): Effect {
  const visits = (storage.readJson<number>('visits.json') ?? 0) + 1;
  storage.writeJson('visits.json', visits);
  console.log('greeting', { visits });
  return {
    effect: 'toast',
    message: shout(
      `${notes.all().length} notes, visit ${visits}, ${clock.today('dddd', 0, ctx.locale)}`
    )
  };
}

function denied() {
  try {
    nativeTools.available('anything');
    return 'allowed';
  } catch (error) {
    return error instanceof HostError
      ? `${error.kind}:${error.detail}`
      : 'other';
  }
}

export const invoke = definePlugin({
  context: (input) => input,
  greet,
  denied,
  later: () => Promise.resolve(1),
  throwsObject: () => {
    throw { reason: 'object' };
  }
});
