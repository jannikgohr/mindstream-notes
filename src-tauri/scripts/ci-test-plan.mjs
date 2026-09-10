import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Select checks without starting browsers or building the app. */
export function testPlan({
  event,
  action,
  label,
  labels = [],
  draft,
  code,
  collab
}) {
  const ignoredLabel =
    event === 'pull_request' && action === 'labeled' && label !== 'ci:app-e2e';
  const force = event === 'workflow_dispatch' || labels.includes('ci:app-e2e');
  const runCode = !ignoredLabel && (force || code);
  const e2e = runCode && (event !== 'pull_request' || !draft || force);
  const suites = ['single'];
  if (force || event === 'push' || collab) {
    suites.push('multi', 'multi-a2');
  }
  return { code: runCode, e2e, suites };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = process.env;
  const plan = testPlan({
    event: env.EVENT,
    action: env.ACTION,
    label: env.LABEL,
    labels: JSON.parse(env.LABELS || 'null') ?? [],
    draft: env.DRAFT === 'true',
    code: env.CODE === 'true',
    collab: env.COLLAB === 'true'
  });
  appendFileSync(
    env.GITHUB_OUTPUT,
    `code=${plan.code}\ne2e=${plan.e2e}\nlist=${JSON.stringify(plan.suites)}\n`
  );
}
