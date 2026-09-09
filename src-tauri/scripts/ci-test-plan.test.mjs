import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPlan } from './ci-test-plan.mjs';

const pr = { event: 'pull_request', code: true, draft: false, labels: [] };

test('drafts keep code checks but defer E2E until ready', () => {
  const draft = testPlan({ ...pr, draft: true, collab: true });
  assert.equal(draft.code, true);
  assert.equal(draft.e2e, false);
  assert.equal(testPlan({ ...pr, action: 'ready_for_review' }).e2e, true);
});

test('ordinary PRs only run the single-client suite', () => {
  assert.deepEqual(testPlan(pr).suites, ['single']);
});

test('collaboration changes run each suite once', () => {
  const plan = testPlan({ ...pr, collab: true });
  assert.deepEqual(plan.suites, ['single', 'multi', 'multi-a2']);
});

test('docs-only changes skip E2E on PRs and main', () => {
  for (const event of ['pull_request', 'push']) {
    const plan = testPlan({ ...pr, event, code: false });
    assert.equal(plan.code, false);
    assert.equal(plan.e2e, false);
  }
});

test('manual and labeled runs override draft and docs gates', () => {
  for (const override of [
    { event: 'workflow_dispatch' },
    { action: 'labeled', label: 'ci:app-e2e', labels: ['ci:app-e2e'] }
  ]) {
    const plan = testPlan({ ...pr, draft: true, code: false, ...override });
    assert.equal(plan.code, true);
    assert.equal(plan.e2e, true);
    assert.equal(plan.suites.length, 3);
  }
});

test('unrelated labels do not rerun checks even with an existing override label', () => {
  const plan = testPlan({
    ...pr,
    action: 'labeled',
    label: 'bug',
    labels: ['ci:app-e2e', 'bug']
  });
  assert.equal(plan.code, false);
  assert.equal(plan.e2e, false);
});

test('main code pushes run every suite', () => {
  const plan = testPlan({ ...pr, event: 'push' });
  assert.equal(plan.e2e, true);
  assert.equal(plan.suites.length, 3);
});
