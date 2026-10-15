/**
 * Set what an account's plan allows, from a named plan in a JSON file.
 *
 *   MINDSTREAM_ADMIN_TOKEN=... node backend/billing/set-plan.mjs \
 *     --server http://localhost:3735 --user ann --plan plus
 *
 *   --plan none     lift every limit from the account
 *   --lapsed        keep the plan's limits and make the account read-only
 *   --show          print what the account uses and may use, change nothing
 *   --plans <file>  the plans to choose from (default: plans.example.json)
 *
 * This is a stand-in for the billing program, which does not exist yet. It
 * talks to the server the way that program will, through the admin
 * interface, and takes the place of the payment provider with a human who
 * names the plan. See README.md.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `--name value` pairs and bare `--flag`s, as an object. */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[arg.slice(2)] = true;
    } else {
      options[arg.slice(2)] = next;
      index += 1;
    }
  }
  return options;
}

/**
 * The body the server expects for a plan. A limit the plan does not name is
 * a limit not applied.
 */
export function entitlementsFor(name, plan, lapsed) {
  const known = [
    'storageLimitBytes',
    'maxSpaces',
    'maxMembersPerSpace',
    'maxItemBytes'
  ];
  const unknown = Object.keys(plan).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`plan "${name}" has unknown limits: ${unknown.join(', ')}`);
  }
  return { plan: name, ...plan, readOnly: lapsed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = options.server ?? 'http://localhost:3735';
  const token = process.env.MINDSTREAM_ADMIN_TOKEN;
  if (!token)
    fail('set MINDSTREAM_ADMIN_TOKEN to the admin token of the server');
  if (typeof options.user !== 'string') fail('name the account with --user');

  const account = `${server}/admin/v1/account/${encodeURIComponent(options.user)}/`;
  const call = async (method, url, body) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 404) fail(`no account named ${options.user}`);
    if (response.status === 401) {
      fail('the server refused the admin token, or its admin interface is off');
    }
    if (!response.ok) {
      fail(`${method} ${url} answered ${response.status}`);
    }
    return response;
  };

  if (options.show) {
    const usage = await call('GET', account);
    console.log(JSON.stringify(await usage.json(), null, 2));
    return;
  }

  if (typeof options.plan !== 'string') fail('name a plan with --plan');
  if (options.plan === 'none') {
    await call('DELETE', `${account}entitlements/`);
    console.log(`${options.user} has no limits`);
    return;
  }

  const file = resolve(here, options.plans ?? 'plans.example.json');
  const plans = JSON.parse(readFileSync(file, 'utf8'));
  const plan = plans[options.plan];
  if (!plan) {
    fail(`no plan "${options.plan}" in ${file}; it has: ${Object.keys(plans)}`);
  }
  const body = entitlementsFor(options.plan, plan, options.lapsed === true);
  await call('PUT', `${account}entitlements/`, body);
  console.log(
    `${options.user} is on ${options.plan}${body.readOnly ? ' (read-only)' : ''}`
  );
}

// Run only when called directly, so the mapping above can be imported.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
