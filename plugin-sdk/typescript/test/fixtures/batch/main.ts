import { batch, definePlugin, HostBatchError } from '@mindstream/plugin-sdk';
export const invoke = definePlugin({
  run: () =>
    batch.execute([
      {
        operation: {
          tag: 'clock-add',
          val: {
            timestamp: batch.text('2026-01-31T12:00:00Z'),
            amount: 1,
            unit: 'month'
          }
        },
        keep: false
      },
      {
        operation: {
          tag: 'clock-format',
          val: {
            timestamp: batch.previous(0),
            pattern: batch.text('YYYY-MM-DD'),
            locale: batch.text('de')
          }
        },
        keep: true
      },
      {
        operation: { tag: 'frontmatter', val: batch.text('{"title":"Batch"}') },
        keep: false
      },
      {
        operation: {
          tag: 'storage-write',
          val: { path: batch.text('value.txt'), contents: batch.previous(2) }
        },
        keep: false
      },
      {
        operation: { tag: 'storage-read', val: batch.text('value.txt') },
        keep: true
      },
      { operation: { tag: 'notes-all' }, keep: true }
    ]),
  denied: () => {
    try {
      batch.execute([{ operation: { tag: 'notes-all' }, keep: true }]);
      return 'allowed';
    } catch (e) {
      return e instanceof HostBatchError
        ? {
            index: e.index,
            kind: e.kind,
            detail: e.detail,
            phase: e.phase,
            completed: e.completed,
            replies: e.replies
          }
        : 'wrong error';
    }
  },
  recover: (input) => {
    try {
      batch.execute([
        {
          operation: {
            tag: 'frontmatter',
            val: batch.text('{"title":"Saved"}')
          },
          keep: true
        },
        {
          operation: {
            tag: 'storage-write',
            val: {
              path: batch.text('checkpoint.txt'),
              contents: batch.previous(0)
            }
          },
          keep: false
        },
        input.validation
          ? {
              operation: { tag: 'frontmatter', val: batch.previous(9) },
              keep: true
            }
          : { operation: { tag: 'notes-all' }, keep: true },
        {
          operation: {
            tag: 'storage-delete',
            val: batch.text('checkpoint.txt')
          },
          keep: false
        }
      ]);
      return 'allowed';
    } catch (e) {
      return e instanceof HostBatchError
        ? {
            index: e.index,
            kind: e.kind,
            phase: e.phase,
            completed: e.completed,
            replies: e.replies
          }
        : 'wrong error';
    }
  }
});
