import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export enum CommandErrorCode {
  Database = 'database',
  Io = 'io',
  NotFound = 'notFound',
  InvalidArgument = 'invalidArgument',
  Tauri = 'tauri',
  Task = 'task',
  Unknown = 'unknown'
}

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}

export type IpcValidator<T> = (value: unknown) => T;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: () => T | Promise<T>,
  validate: IpcValidator<T> = (value) => value as T
): Promise<T> {
  if (!isTauri()) return await fallback();
  return validate(await tauriInvoke<unknown>(command, args));
}

export function assertRecord(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  return value;
}

export function assertNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

export function assertBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean`);
  }
  return value;
}

export function assertStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => assertString(item, `${context}[${index}]`));
}

export function assertNumberArray(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => assertNumber(item, `${context}[${index}]`));
}

export function optionalString(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, context);
}
