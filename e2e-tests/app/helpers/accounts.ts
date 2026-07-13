/**
 * Two-account provisioning for the T4 sharing specs (docs/e2e/backend-stack.md
 * §2.1). Collection sharing needs two **distinct** Etebase users — a sender
 * whose `fetch_user_profile` resolves the recipient's public key — so the
 * one-account/two-device trick the collab matrix uses isn't enough here.
 *
 * We create them the same way the app would: a real Etebase **signup**, which
 * runs the client-side crypto (password-derived login key, identity keypair,
 * encrypted account blob) and uploads the pubkey the sender later resolves. A
 * Django-admin-created user has none of that and can neither be logged into nor
 * resolved, so signup is the only route. It requires the signup endpoint to be
 * open — the disposable test stack sets `AUTO_SIGNUP=true` (Etebase blocks it
 * by default); against a stack without it, `signupAccount` throws.
 *
 * This runs in the wdio (Node) runner via the `etebase` JS SDK. The users it
 * creates are standard Etebase accounts, so the Rust client (`Account::login`)
 * signs into them unchanged.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Etebase from 'etebase';

/** Credentials the app logs in with — never a live session, just the inputs. */
export interface TestAccount {
  username: string;
  email: string;
  password: string;
}

export interface TwoAccounts {
  /** Account A — creates and shares the folder. */
  sender: TestAccount;
  /** Account B — receives the share bundle. */
  recipient: TestAccount;
}

/**
 * A per-run token so parallel/repeated runs against the same (un-reset) stack
 * never collide on a username. base36 timestamp + random keeps it short,
 * lowercase, and within Etebase's username charset.
 */
function runToken(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function makeAccount(role: 'sender' | 'recipient', token: string): TestAccount {
  return {
    username: `e2e-${role}-${token}`,
    email: `e2e-${role}-${token}@e2e.local`,
    // Not a secret — a throwaway account on a disposable local stack.
    password: `e2e-${token}-passphrase`
  };
}

/**
 * Sign a single account up against `serverUrl`, then log it out again. Signup
 * is all we need here — it registers the user and its pubkey server-side; the
 * app instance logs in fresh with the returned credentials. Logout releases the
 * session token so we don't leave it dangling.
 *
 * Throws if the server rejects signup (e.g. AUTO_SIGNUP is off, or the username
 * is already taken on an un-reset stack).
 */
export async function signupAccount(
  serverUrl: string,
  account: TestAccount
): Promise<void> {
  await Etebase.ready;
  const etebase = await Etebase.Account.signup(
    { username: account.username, email: account.email },
    account.password,
    serverUrl
  );
  await etebase.logout();
}

/**
 * Optional on-disk cache of provisioned accounts, keyed by server URL, for
 * local iteration where speed matters more than isolation. The default is a
 * fresh pair per call because remote Etebase state (vault collections, share
 * invites, notification bundles, seed edits) survives as long as the test
 * stack volume does. Gitignored (throwaway local creds). Set
 * `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` to opt into the cache.
 */
const CACHE_FILE = fileURLToPath(
  new URL('./.t4-accounts.json', import.meta.url)
);

type AccountsCache = Record<string, TwoAccounts>;

function readCache(): AccountsCache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as AccountsCache;
  } catch {
    return {};
  }
}

function writeCache(cache: AccountsCache): void {
  try {
    writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (err) {
    // Non-fatal: a missing cache just means the next run re-provisions.
    console.warn('[e2e] could not persist account cache:', err);
  }
}

/**
 * Whether a cached account still logs in against `serverUrl`. Returns false if
 * the stack was reset (the user no longer exists) so the caller re-provisions.
 */
async function accountUsable(
  serverUrl: string,
  account: TestAccount
): Promise<boolean> {
  await Etebase.ready;
  try {
    const etebase = await Etebase.Account.login(
      account.username,
      account.password,
      serverUrl
    );
    await etebase.logout();
    return true;
  } catch {
    return false;
  }
}

async function provisionFreshPair(serverUrl: string): Promise<TwoAccounts> {
  const token = runToken();
  const sender = makeAccount('sender', token);
  const recipient = makeAccount('recipient', token);
  await signupAccount(serverUrl, sender);
  await signupAccount(serverUrl, recipient);
  return { sender, recipient };
}

/**
 * Return a sender + recipient pair for `serverUrl`. By default this signs up a
 * fresh pair every time so suites do not inherit server-side state from an
 * earlier suite or an old still-running test stack. With
 * `MINDSTREAM_E2E_REUSE_ACCOUNTS=1`, cached accounts are reused when they still
 * log in, and a fresh pair is persisted otherwise. Both accounts share one run
 * token so they're obviously a pair in logs.
 */
export async function provisionTwoAccounts(
  serverUrl: string
): Promise<TwoAccounts> {
  const reuseAccounts = process.env.MINDSTREAM_E2E_REUSE_ACCOUNTS === '1';
  const cache = readCache();
  const cached = cache[serverUrl];

  if (reuseAccounts && cached) {
    const [senderOk, recipientOk] = await Promise.all([
      accountUsable(serverUrl, cached.sender),
      accountUsable(serverUrl, cached.recipient)
    ]);
    if (senderOk && recipientOk) return cached;
  }

  const fresh = await provisionFreshPair(serverUrl);
  if (reuseAccounts) {
    cache[serverUrl] = fresh;
    writeCache(cache);
  }
  return fresh;
}
