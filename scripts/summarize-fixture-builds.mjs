import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Report retained fixture timings without changing compiler or cache inputs.
// A report can come from a reused Cargo output directory, so it is evidence
// of that fixture build, not proof that the current invocation rebuilt it.
function reports(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return reports(path);
    return entry.isFile() && entry.name === 'fixture-build-timings.json'
      ? [path]
      : [];
  });
}

const lines = [
  '## Guest fixture build reports',
  '',
  'These reports describe the fixture build that produced each output directory. Cargo may reuse a report without running that build again.',
  ''
];
const files = process.argv.slice(2).flatMap(reports).sort();
for (const file of files) {
  lines.push(
    `Report: \`${file}\``,
    '',
    '| Fixture | Seconds | Cache |',
    '| --- | ---: | --- |'
  );
  for (const { name, seconds, cacheHit } of JSON.parse(
    readFileSync(file, 'utf8')
  )) {
    const cache =
      cacheHit === true
        ? 'hit'
        : cacheHit === false
          ? 'miss'
          : 'Cargo validation';
    lines.push(`| ${name} | ${seconds.toFixed(2)} | ${cache} |`);
  }
  lines.push('');
}
if (!files.length) lines.push('No fixture build report was produced.', '');
const summary = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
