// Cargo target runner and direct executable runner for a connected Android
// device. ANDROID_SERIAL selects one device when several are connected.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const [binary, ...args] = process.argv.slice(2);
if (!binary)
  throw new Error(
    'usage: node plugin-sdk/android-runner.mjs <binary> [args...]'
  );
const remote = `/data/local/tmp/mindstream-plugin-${randomUUID()}`;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function adb(args, options = {}) {
  const result = spawnSync(process.env.ADB ?? 'adb', args, {
    stdio: 'inherit',
    ...options
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
let status;
try {
  if (adb(['shell', 'mkdir', '-p', remote]))
    throw new Error('could not create device scratch directory');
  if (adb(['push', resolve(binary), `${remote}/probe`]))
    throw new Error('could not copy executable to the device');
  status = adb([
    'shell',
    `chmod 700 ${remote}/probe && TMPDIR=${quote(remote)} ${remote}/probe ${args.map(quote).join(' ')}`
  ]);
} finally {
  adb(['shell', 'rm', '-rf', remote]);
}
process.exitCode = status;
