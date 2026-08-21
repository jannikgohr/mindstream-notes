export type InlineListEditTrigger = 'enter' | 'escape' | 'blur';

export type InlineListEditResult =
  | { type: 'commit'; value: string }
  | { type: 'cancel' };

export function resolveInlineListEdit(
  value: string,
  trigger: InlineListEditTrigger
): InlineListEditResult {
  if (trigger !== 'enter') return { type: 'cancel' };
  const next = value.trim();
  return next ? { type: 'commit', value: next } : { type: 'cancel' };
}
