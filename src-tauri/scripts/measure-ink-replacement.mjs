import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../..');
const srcTauriDir = join(projectRoot, 'src-tauri');

const cargoToml = readFileSync(join(srcTauriDir, 'Cargo.toml'), 'utf8');
const cargoDependencies = parseCargoDependencies(cargoToml);
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
);

const snapshot = {
  generatedAt: new Date().toISOString(),
  commit: run('git', ['rev-parse', '--short', 'HEAD']),
  status: run('git', ['status', '--short']) || 'clean',
  dependencies: dependencySnapshot(),
  scripts: {
    measureInkReplacement: Boolean(
      packageJson.scripts?.['measure:ink-replacement']
    )
  },
  artifacts: {
    androidPackages: findFiles(
      [join(srcTauriDir, 'gen', 'android', 'app', 'build', 'outputs')],
      (path) => ['.apk', '.aab'].includes(extname(path).toLowerCase())
    ),
    androidNativeLibs: findFiles(
      [
        join(
          srcTauriDir,
          'gen',
          'android',
          'app',
          'build',
          'intermediates',
          'stripped_native_libs'
        )
      ],
      (path) =>
        basename(path) === 'libmindstream_notes_lib.so' &&
        path.includes('Release')
    ),
    cargoNativeLibs: findCargoNativeLibs()
  }
};

printMarkdown(snapshot);

function dependencySnapshot() {
  const names = [
    'ink-core',
    'wgpu',
    'egui',
    'egui-wgpu',
    'egui-shadcn',
    'lucide-icons',
    'bytemuck',
    'pollster'
  ];

  return names.map((name) => ({
    name,
    present: new RegExp(`^${escapeRegExp(name)}\\s*=`, 'm').test(cargoToml),
    spec: cargoDependencies
      .filter((dep) => dep.name === name)
      .map((dep) => ({
        spec: dep.spec,
        section: dep.section,
        appliesToAndroid: dep.appliesToAndroid
      }))
  }));
}

function parseCargoDependencies(toml) {
  const deps = [];
  let section = '';
  let inDependencySection = false;
  let appliesToAndroid = false;

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = `[${sectionMatch[1]}]`;
      inDependencySection =
        section.endsWith('.dependencies]') || section === '[dependencies]';
      appliesToAndroid =
        section === '[dependencies]' ||
        ((section.includes('target_os = "android"') ||
          section.includes("target_os = 'android'")) &&
          !section.includes('not(any(target_os = "android"') &&
          !section.includes("not(any(target_os = 'android'") &&
          !section.includes('not(target_os = "android"') &&
          !section.includes("not(target_os = 'android'"));
      continue;
    }

    if (!inDependencySection) continue;
    const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!depMatch) continue;
    deps.push({
      name: depMatch[1],
      spec: depMatch[2].trim(),
      section,
      appliesToAndroid
    });
  }

  return deps;
}

function findCargoNativeLibs() {
  const targetDir = join(srcTauriDir, 'target');
  if (!existsSync(targetDir)) return [];

  const roots = [];
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'release') {
      roots.push(join(targetDir, entry.name));
    } else if (entry.name.includes('android')) {
      roots.push(join(targetDir, entry.name, 'release'));
    }
  }

  return findFiles(roots, (path) =>
    ['libmindstream_notes_lib.so', 'mindstream_notes_lib.dll'].includes(
      basename(path)
    )
  );
}

function findFiles(roots, predicate) {
  const out = [];
  for (const root of roots) {
    walk(root, predicate, out);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function walk(root, predicate, out) {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (predicate(root)) {
      out.push(fileInfo(root, stat));
    }
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'deps') continue;
    walk(join(root, entry.name), predicate, out);
  }
}

function fileInfo(path, stat = statSync(path)) {
  return {
    path: relative(projectRoot, path).replaceAll('\\', '/'),
    bytes: stat.size,
    size: formatBytes(stat.size),
    modifiedAt: stat.mtime.toISOString()
  };
}

function printMarkdown(data) {
  console.log('# Ink Replacement Measurement Snapshot');
  console.log('');
  console.log(`- generated_at: ${data.generatedAt}`);
  console.log(`- commit: ${data.commit}`);
  console.log(`- working_tree: ${data.status === 'clean' ? 'clean' : 'dirty'}`);
  if (data.status !== 'clean') {
    console.log('');
    console.log('```');
    console.log(data.status);
    console.log('```');
  }

  console.log('');
  console.log('## Native Ink Dependencies');
  for (const dep of data.dependencies) {
    if (!dep.present) {
      console.log(`- ${dep.name}: absent`);
      continue;
    }
    const androidState = dep.spec.some((entry) => entry.appliesToAndroid)
      ? 'android'
      : 'desktop-only';
    const specs = dep.spec
      .map((entry) => `${entry.spec} in ${entry.section}`)
      .join('; ');
    console.log(`- ${dep.name}: present (${androidState}) ${specs}`);
  }

  console.log('');
  console.log('## Package Scripts');
  console.log(
    `- measure:ink-replacement: ${yesNo(data.scripts.measureInkReplacement)}`
  );

  printFiles('Android APK/AAB Outputs', data.artifacts.androidPackages);
  printFiles('Android Native Libraries', data.artifacts.androidNativeLibs);
  printFiles('Cargo Native Libraries', data.artifacts.cargoNativeLibs);
}

function printFiles(title, files) {
  console.log('');
  console.log(`## ${title}`);
  if (files.length === 0) {
    console.log('- none found');
    return;
  }
  for (const file of files) {
    console.log(`- ${file.path}: ${file.size} (${file.bytes} bytes)`);
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}
