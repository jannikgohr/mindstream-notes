// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./wit.d.ts" />
/**
 * The globals a plugin's JavaScript engine lacks, wired to the host.
 *
 * A component has no clock, no random source and no console of its own. Left
 * alone, `Date.now()` would crash the call, `console.log` would throw, and
 * `Math.random()` would return the same sequence in every call, because the
 * engine's state is snapshotted when the plugin is built. These replacements
 * ask the host instead.
 *
 * They are installed when the SDK module is evaluated, which happens while
 * the plugin is being built, so nothing here may call the host at that time.
 */

import * as clockHost from 'mindstream:plugin/clock@0.1.0';
import * as runtimeHost from 'mindstream:plugin/runtime@0.1.0';

type Level = 'debug' | 'info' | 'warn' | 'error';

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error)
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function installConsole(): void {
  const line =
    (level: Level) =>
    (...args: unknown[]): void =>
      runtimeHost.log(level, format(args));
  const consoleLike = {
    debug: line('debug'),
    log: line('info'),
    info: line('info'),
    warn: line('warn'),
    error: line('error')
  };
  (globalThis as { console?: unknown }).console = consoleLike;
}

function installDate(): void {
  const RealDate = Date;
  // A function rather than a class, so `Date()` without `new` keeps working.
  function HostDate(this: unknown, ...args: unknown[]): Date | string {
    if (!new.target) {
      return new RealDate(clockHost.nowMillis()).toString();
    }
    const construct = args.length === 0 ? [clockHost.nowMillis()] : args;
    return Reflect.construct(RealDate, construct, new.target) as Date;
  }
  Object.setPrototypeOf(HostDate, RealDate);
  HostDate.prototype = RealDate.prototype;
  Object.defineProperty(HostDate, 'now', {
    value: () => clockHost.nowMillis(),
    writable: true,
    configurable: true
  });
  (globalThis as { Date: unknown }).Date = HostDate;
}

function fillRandom<T extends ArrayBufferView | null>(view: T): T {
  if (!view) return view;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = runtimeHost.randomBytes(
      Math.min(65536, bytes.length - offset)
    );
    bytes.set(chunk, offset);
  }
  return view;
}

function installRandom(): void {
  const cryptoLike = {
    getRandomValues: fillRandom,
    randomUUID: () => runtimeHost.uuid()
  };
  (globalThis as { crypto?: unknown }).crypto = cryptoLike;
  Math.random = () => {
    const bytes = runtimeHost.randomBytes(7);
    // 53 random bits, as a double in [0, 1).
    let value = bytes[0] & 0x1f;
    for (let i = 1; i < 7; i++) value = value * 256 + bytes[i];
    return value / 2 ** 53;
  };
}

let installed = false;

export function installGlobals(): void {
  if (installed) return;
  installed = true;
  installConsole();
  installDate();
  installRandom();
}
