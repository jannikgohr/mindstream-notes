// Test-host adapter for the typed batch interface. Scalar imports retain policy.
export function createBatchHost(imports) {
  const api = (name) => imports[`mindstream:plugin/${name}@0.1.0`];
  const invalid = (message) => {
    throw { tag: 'invalid', val: message };
  };
  const texts = (op) => {
    switch (op.tag) {
      case 'log':
        return [op.val.message];
      case 'clock-add':
        return [op.val.timestamp];
      case 'clock-format':
        return [
          op.val.timestamp,
          op.val.pattern,
          ...(op.val.locale ? [op.val.locale] : [])
        ];
      case 'storage-write':
        return [op.val.path, op.val.contents];
      case 'tool-run':
        return [
          op.val.toolId,
          ...op.val.args,
          ...(op.val.stdin ? [op.val.stdin] : [])
        ];
      case 'has-permission':
      case 'frontmatter':
      case 'notes-get':
      case 'storage-read':
      case 'storage-list':
      case 'storage-delete':
      case 'tool-available':
        return [op.val];
      default:
        return [];
    }
  };
  const textOps = new Set([
    'uuid',
    'now',
    'clock-add',
    'clock-format',
    'frontmatter',
    'storage-read'
  ]);
  const bytes = (s) => Buffer.byteLength(s ?? '');
  const noteSize = (n) =>
    64 +
    bytes(n.id) +
    bytes(n.title) +
    n.tags.reduce((n, t) => n + bytes(t) + 8, 0) +
    bytes(n.kind) +
    bytes(n.folderId) +
    bytes(n.folderPath) +
    bytes(n.created) +
    bytes(n.modified);
  const size = (v) =>
    32 +
    ({
      text: () => bytes(v.val),
      'optional-text': () => bytes(v.val),
      bytes: () => v.val.length,
      notes: () => v.val.reduce((n, v) => n + noteSize(v), 0),
      note: () => (v.val ? noteSize(v.val) : 0),
      entries: () => v.val.reduce((n, e) => n + 32 + bytes(e.name), 0),
      tool: () =>
        32 +
        bytes(v.val.stdout) +
        bytes(v.val.stdoutBase64) +
        bytes(v.val.stderr)
    }[v.tag]?.() ?? 0);
  return {
    execute(commands) {
      let index = 0;
      let phase = 'validation';
      let completed = 0;
      const replies = [];
      try {
        if (commands.length > 128) invalid('batch: at most 128 commands');
        let inputBytes = 0;
        let inputCount = 0;
        for (let i = 0; i < commands.length; i++) {
          index = i;
          if (
            commands[i].operation.tag === 'tool-run' &&
            commands[i].operation.val.args.length > 1024
          )
            invalid('batch: at most 1024 text inputs');
          const args = texts(commands[i].operation);
          inputCount += args.length;
          if (inputCount > 1024) invalid('batch: at most 1024 text inputs');
          for (const value of args) {
            if (value.tag === 'literal') inputBytes += bytes(value.val);
            else if (
              value.tag !== 'previous' ||
              !Number.isInteger(value.val) ||
              value.val < 0 ||
              value.val >= i ||
              !textOps.has(commands[value.val].operation.tag)
            )
              invalid(
                'batch: reference must point to an earlier text-producing operation'
              );
          }
          if (inputBytes > 1048576)
            invalid('batch: literal input exceeds 1 MiB');
        }
        const values = [];
        let resultBytes = 0;
        const text = (value) => {
          if (value.tag === 'literal') return value.val;
          const previous = values[value.val];
          if (
            (previous.tag === 'text' || previous.tag === 'optional-text') &&
            typeof previous.val === 'string'
          )
            return previous.val;
          return invalid('batch: reference has no text value');
        };
        const dispatch = (op) => {
          const a = op.val;
          switch (op.tag) {
            case 'log':
              api('runtime').log(a.level, text(a.message));
              return { tag: 'none' };
            case 'uuid':
              return { tag: 'text', val: api('runtime').uuid() };
            case 'random-bytes':
              return { tag: 'bytes', val: api('runtime').randomBytes(a) };
            case 'has-permission':
              return {
                tag: 'boolean',
                val: api('runtime').hasPermission(text(a))
              };
            case 'now-millis':
              return { tag: 'number', val: api('clock').nowMillis() };
            case 'now':
              return { tag: 'text', val: api('clock').now() };
            case 'clock-add':
              return {
                tag: 'text',
                val: api('clock').add(text(a.timestamp), a.amount, a.unit)
              };
            case 'clock-format':
              return {
                tag: 'text',
                val: api('clock').format(
                  text(a.timestamp),
                  text(a.pattern),
                  a.locale ? text(a.locale) : undefined
                )
              };
            case 'frontmatter':
              return { tag: 'text', val: api('markdown').frontmatter(text(a)) };
            case 'notes-all':
              return { tag: 'notes', val: api('notes').all() };
            case 'notes-get':
              return { tag: 'note', val: api('notes').get(text(a)) };
            case 'storage-read':
              return {
                tag: 'optional-text',
                val: api('storage').read(text(a))
              };
            case 'storage-list':
              return { tag: 'entries', val: api('storage').list(text(a)) };
            case 'storage-write':
              api('storage').write(text(a.path), text(a.contents));
              return { tag: 'none' };
            case 'storage-delete':
              api('storage').delete(text(a));
              return { tag: 'none' };
            case 'tool-available':
              return {
                tag: 'boolean',
                val: api('native-tools').available(text(a))
              };
            case 'tool-run':
              return {
                tag: 'tool',
                val: api('native-tools').run(text(a.toolId), {
                  args: a.args.map(text),
                  stdin: a.stdin ? text(a.stdin) : undefined,
                  timeoutMs: a.timeoutMs,
                  outputBase64: a.outputBase64
                })
              };
            default:
              return invalid('unknown batch operation');
          }
        };
        for (let i = 0; i < commands.length; i++) {
          index = i;
          phase = 'execution';
          const value = dispatch(commands[i].operation);
          completed = i + 1;
          phase = 'result-limit';
          resultBytes += size(value);
          if (resultBytes > 8388608)
            invalid('batch: result data exceeds 8 MiB');
          values.push(value);
          if (commands[i].keep) replies.push({ index: i, value });
        }
        return replies;
      } catch (error) {
        const cause = error?.payload ?? error;
        throw {
          payload: {
            index,
            phase,
            completed,
            replies,
            cause: cause?.tag ? cause : { tag: 'failed', val: String(error) }
          }
        };
      }
    }
  };
}
