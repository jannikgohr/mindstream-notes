import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFailureArtifacts } from './failure-capture.js';

test('saves HTML before a screenshot that never resolves', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  try {
    await captureFailureArtifacts({
      title: 'hung screenshot',
      outputDir,
      timeoutMs: 20,
      client: {
        execute: async () => ({
          html: '<html>configuration</html>',
          url: 'tauri://localhost',
          viewport: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 }
        }),
        saveScreenshot: () => new Promise(() => {})
      }
    });
    const files = readdirSync(outputDir);
    assert.match(
      readFileSync(
        join(outputDir, files.find((name) => name.endsWith('.html'))!),
        'utf8'
      ),
      /configuration/
    );
    const report = JSON.parse(
      readFileSync(
        join(outputDir, files.find((name) => name.endsWith('.json'))!),
        'utf8'
      )
    );
    assert.equal(report.captureStatus, 'partial');
    assert.match(report.captureErrors[0], /screenshot.*timed out/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('writes failure metadata even when both driver commands hang', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  try {
    await captureFailureArtifacts({
      title: 'hung driver',
      outputDir,
      error: new Error('original failure'),
      timeoutMs: 20,
      client: {
        execute: () => new Promise(() => {}),
        saveScreenshot: () => new Promise(() => {})
      }
    });
    const file = readdirSync(outputDir).find((name) => name.endsWith('.json'))!;
    const report = JSON.parse(readFileSync(join(outputDir, file), 'utf8'));
    assert.equal(report.error.message, 'original failure');
    assert.equal(report.captureStatus, 'partial');
    assert.equal(report.captureErrors.length, 2);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
