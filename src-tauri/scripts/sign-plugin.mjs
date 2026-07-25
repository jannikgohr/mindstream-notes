#!/usr/bin/env node
/**
 * Sign a plugin so the app can verify its authorship.
 *
 * Produces `<plugin-dir>/signature.json` — an Ed25519 signature over the exact
 * bytes of `<plugin-dir>/manifest.json`, in the format the Rust verifier expects
 * (see src-tauri/src/plugins/signing.rs):
 *
 *   { "algorithm": "ed25519", "publicKey": "<base64 32B>", "signature": "<base64 64B>" }
 *
 * Usage:
 *   node sign-plugin.mjs <plugin-dir> --key <ed25519-private-key.pem>
 *   node sign-plugin.mjs <plugin-dir> --generate <out-private-key.pem>
 *
 * `--generate` mints a new Ed25519 keypair, writes the PKCS8 private key to the
 * given path (KEEP IT SECRET — it's the author identity; the app pins its public
 * fingerprint on first approval), and signs with it. Re-sign with the SAME key
 * after editing a plugin so its updates auto-approve instead of being gated.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign
} from 'node:crypto';

function fail(msg) {
  console.error(`sign-plugin: ${msg}`);
  process.exit(1);
}

const [, , pluginDir, flag, flagArg] = process.argv;
if (!pluginDir || !flag) {
  fail('usage: sign-plugin.mjs <plugin-dir> (--key <pem> | --generate <pem>)');
}

let privateKey;
if (flag === '--generate') {
  if (!flagArg) fail('--generate requires an output path for the private key');
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  writeFileSync(flagArg, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  console.log(`Generated a new signing key at ${flagArg} — keep it secret.`);
} else if (flag === '--key') {
  if (!flagArg) fail('--key requires a path to an Ed25519 PKCS8 private key');
  privateKey = createPrivateKey(readFileSync(flagArg));
} else {
  fail(`unknown flag ${flag}`);
}

// Raw 32-byte public key from the JWK `x` field (base64url).
const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') fail('key is not Ed25519');
const publicKeyRaw = Buffer.from(jwk.x, 'base64url');

const manifestBytes = readFileSync(join(pluginDir, 'manifest.json'));
const signature = edSign(null, manifestBytes, privateKey); // 64 bytes

const out = {
  algorithm: 'ed25519',
  publicKey: publicKeyRaw.toString('base64'),
  signature: signature.toString('base64')
};
writeFileSync(
  join(pluginDir, 'signature.json'),
  JSON.stringify(out, null, 2) + '\n'
);

const fingerprint = createHash('sha256').update(publicKeyRaw).digest('hex');
console.log(`Wrote ${join(pluginDir, 'signature.json')}`);
console.log(`Signer fingerprint: ${fingerprint}`);
