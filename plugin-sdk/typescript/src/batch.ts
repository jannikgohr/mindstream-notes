import * as batchHost from 'mindstream:plugin/batch@0.1.0';
import type { HostErrorKind } from './index';

export type BatchCommand = batchHost.Command;
export type BatchReply = batchHost.Reply;
export type BatchOperation = batchHost.Operation;
export type BatchText = batchHost.TextInput;
export type BatchFailurePhase = batchHost.FailurePhase;

/** Where the batch stopped. Effects are not rolled back; the stopping operation
 * may also have effects. completed counts successful handlers, not durable writes.
 */
export class HostBatchError extends Error {
  constructor(
    readonly index: number,
    readonly kind: HostErrorKind,
    readonly detail: string,
    readonly phase: BatchFailurePhase,
    readonly completed: number,
    readonly replies: BatchReply[]
  ) {
    super(`batch command ${index}: ${detail}`);
    this.name = 'HostBatchError';
  }
}

/** Explicit ordered plan over all current host capabilities, at most 128 commands.
 * Reference earlier text results with previous(index), including unkept results.
 * A result needed for guest branching requires execute followed by another plan.
 * Deadline/cancellation traps remain fatal, rather than HostBatchError values.
 */
export const batch = {
  text(value: string): BatchText {
    return { tag: 'literal', val: value };
  },
  previous(index: number): BatchText {
    return { tag: 'previous', val: index };
  },
  execute(commands: BatchCommand[]): BatchReply[] {
    try {
      return batchHost.execute(commands);
    } catch (error) {
      const failure = (error as { payload?: batchHost.Failure })?.payload;
      if (failure?.cause && typeof failure.index === 'number') {
        throw new HostBatchError(
          failure.index,
          failure.cause.tag,
          failure.cause.val,
          failure.phase,
          failure.completed,
          failure.replies
        );
      }
      throw error;
    }
  }
};
