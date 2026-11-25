import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-svelte's standard className helper. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Same order as `a.localeCompare(b, undefined, { sensitivity: 'base' })`,
// which builds a collator on every call: slow over a vault's worth of names.
const labelCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Case- and accent-insensitive order for names, titles and tags. */
export const compareLabels = labelCollator.compare;
