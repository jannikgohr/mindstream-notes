export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}
