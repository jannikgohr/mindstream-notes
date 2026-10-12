#!/usr/bin/env node
/**
 * Backend benchmark: the load the app puts on its sync server, replayed from
 * Node against a running stack.
 *
 *   pnpm backend:test:up
 *   pnpm bench:backend                          # quick pass, about a minute
 *   pnpm bench:backend --scale full             # 1000-note pushes, 8 MiB assets
 *   pnpm bench:backend --rtt 40                 # add a column projected to a 40 ms link
 *   pnpm bench:backend --label new --compare .output/bench/backend/etebase.json
 *   pnpm bench:backend diff a.json b.json       # compare two saved runs
 *
 * It speaks the Etebase protocol, and for live collaboration either the two
 * relays of the old stack or the rooms built into the new server, whichever
 * the server at `--url` has. So the same run works against both: point
 * `--url` (or MINDSTREAM_E2E_BACKEND_URL) at a server, give the run a
 * `--label`, and compare the result files.
 *
 * Every row reports wall time next to the number of HTTP requests and the time
 * and bytes those took. On localhost a request costs a millisecond or two; on
 * a real link each one costs a round trip, which is why the request column
 * matters more than the wall time for the many-small-requests scenarios.
 *
 * Docker Desktop on Windows delays the second write on every new connection
 * by about 45 ms, which lands on the join answer and inflates the `live.join`
 * and `live.open_note` rows. The same join measured from inside the Docker
 * network takes under half a millisecond. Requests on kept-alive connections
 * and frames on established sockets are not affected.
 *
 * The run signs up fresh accounts and leaves their data behind, like the T4
 * suites. It makes 8 auth requests, and the nginx edge allows 10 a minute
 * (burst 20), so three runs back to back will hit a 429.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  relayTransport,
  roomsTransport,
  roundTrips,
  settle,
  throughput
} from './collab.mjs';
import {
  closeHttpMeter,
  httpSince,
  httpSnapshot,
  installHttpMeter,
  summarise,
  summariseLatencies
} from './meter.mjs';
import { Device, freshCredentials, login, signup } from './vault.mjs';
import { BenchNote, makeAsset } from './workload.mjs';

const KIB = 1024;
const MIB = 1024 * KIB;

const SCALES = {
  quick: {
    reps: 20,
    bulkNotes: [100],
    bulkEdits: 25,
    noteBytes: 2 * KIB,
    assetBytes: [MIB],
    sharedAssets: { count: 8, bytes: 128 * KIB },
    frames: 300,
    fanoutPeers: 8,
    throughputFrames: 5_000
  },
  full: {
    reps: 50,
    bulkNotes: [100, 1000],
    bulkEdits: 100,
    noteBytes: 2 * KIB,
    assetBytes: [MIB, 8 * MIB],
    sharedAssets: { count: 32, bytes: 256 * KIB },
    frames: 1_000,
    fanoutPeers: 32,
    throughputFrames: 20_000
  }
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    scale: { type: 'string', default: 'quick' },
    label: { type: 'string', default: 'etebase' },
    out: { type: 'string' },
    compare: { type: 'string' },
    rtt: { type: 'string' },
    'docker-project': { type: 'string', default: 'mindstream-test' }
  }
});

// ---------- reporting ----------

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${ms.toFixed(0)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function fmtBytes(bytes) {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

/** An exact size for a scenario name, e.g. "16 KiB". */
function fmtSize(bytes) {
  if (bytes >= MIB) return `${bytes / MIB} MiB`;
  if (bytes >= KIB) return `${bytes / KIB} KiB`;
  return `${bytes} B`;
}

function printTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length))
  );
  for (const row of rows) {
    // Labels at either end read left to right; the figures between them are
    // right-aligned.
    const cells = row.map((cell, column) =>
      column === 0 || column === row.length - 1
        ? cell.padEnd(widths[column])
        : cell.padStart(widths[column])
    );
    console.log(cells.join('  ').trimEnd());
  }
}

function printResults(run, rttMs) {
  const header = ['scenario', 'n', 'p50', 'p95', 'req', 'in http', 'received'];
  if (rttMs) header.push(`@${rttMs} ms rtt`);
  header.push('');
  const rows = [header];
  for (const result of run.results) {
    const usesHttp = result.requests > 0;
    const row = [
      result.name,
      String(result.n),
      fmtMs(result.wallMs.p50),
      fmtMs(result.wallMs.p95),
      usesHttp ? String(result.requests) : '-',
      usesHttp ? fmtMs(result.httpMs) : '-',
      usesHttp ? fmtBytes(result.rxBytes) : '-'
    ];
    if (rttMs) {
      // Requests are sequential, so each one adds a round trip.
      row.push(
        usesHttp ? fmtMs(result.wallMs.p50 + result.requests * rttMs) : '-'
      );
    }
    row.push(result.detail ?? '');
    rows.push(row);
  }
  console.log();
  printTable(rows);
  for (const { name, reason } of run.skipped) {
    console.log(`SKIPPED ${name}: ${reason}`);
  }
  for (const [moment, containers] of Object.entries(run.footprint ?? {})) {
    const total = containers.reduce((sum, c) => sum + c.memMiB, 0);
    console.log(`\nmemory ${moment}: ${total.toFixed(0)} MiB`);
    for (const container of containers) {
      console.log(
        `  ${container.name.padEnd(34)} ${container.memMiB.toFixed(0).padStart(5)} MiB`
      );
    }
  }
}

function printComparison(base, current) {
  if (base.meta.scale !== current.meta.scale) {
    console.log(
      `\nwarning: comparing a "${base.meta.scale}" run with a "${current.meta.scale}" run; ` +
        'only scenarios with the same parameters line up.'
    );
  }
  const rows = [
    [
      'scenario',
      `${base.meta.label} p50`,
      `${current.meta.label} p50`,
      'change',
      'req'
    ]
  ];
  for (const now of current.results) {
    const before = base.results.find((result) => result.name === now.name);
    if (!before) continue;
    const ratio = before.wallMs.p50 / now.wallMs.p50;
    rows.push([
      now.name,
      fmtMs(before.wallMs.p50),
      fmtMs(now.wallMs.p50),
      describeChange(ratio),
      before.requests || now.requests
        ? `${before.requests} -> ${now.requests}`
        : '-'
    ]);
  }
  console.log(`\n${base.meta.label} -> ${current.meta.label}`);
  printTable(rows);
}

/** Two runs of one server differ by 10-40%, so small ratios are noise. */
function describeChange(ratio) {
  if (ratio > 1 / 1.05 && ratio < 1.05) return 'same';
  return ratio >= 1
    ? `${ratio.toFixed(1)}x faster`
    : `${(1 / ratio).toFixed(1)}x slower`;
}

function loadRun(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

// ---------- measuring ----------

const run = { meta: {}, results: [], skipped: [], footprint: {} };

function record(name, summary, detail) {
  run.results.push({ name, ...summary, detail });
  process.stdout.write('.');
}

/**
 * Time `spec.run` `reps` times. `spec.before` is untimed per-repetition setup
 * whose return value is handed to `run` and `after`; `warmup` repetitions run
 * first and are thrown away.
 */
async function time(name, reps, spec) {
  const samples = [];
  for (let i = -(spec.warmup ?? 0); i < reps; i++) {
    const prepared = spec.before ? await spec.before() : undefined;
    const http = httpSnapshot();
    const started = performance.now();
    await spec.run(prepared);
    const wallMs = performance.now() - started;
    if (i >= 0) samples.push({ wallMs, ...httpSince(http) });
    if (spec.after) await spec.after(prepared);
  }
  const summary = summarise(samples);
  const detail = spec.per
    ? `${fmtMs(summary.wallMs.p50 / spec.per.count)}/${spec.per.unit}`
    : spec.detail;
  record(name, summary, detail);
}

/** Memory of each container in the stack, or null when Docker can't say. */
function dockerFootprint(project) {
  const ps = spawnSync(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`],
    { encoding: 'utf8' }
  );
  const ids = ps.status === 0 ? ps.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.length === 0) return null;
  const stats = spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...ids],
    { encoding: 'utf8' }
  );
  if (stats.status !== 0) return null;
  const toMiB = { B: 1 / MIB, KiB: 1 / KIB, MiB: 1, GiB: KIB };
  return stats.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [name, usage] = line.split('\t');
      const [, amount, unit] = /^([\d.]+)(\w+)/.exec(usage);
      return { name, memMiB: Number(amount) * toMiB[unit] };
    })
    .sort((a, b) => b.memMiB - a.memMiB);
}

/**
 * Whether the server has rooms of its own, as opposed to the separate
 * relays of the old stack. It says so on a route only it serves.
 */
async function hasBuiltInRooms(url) {
  try {
    const response = await fetch(`${url}/api/v1/mindstream/info/`);
    return (
      response.ok && (await response.json()).server === 'mindstream-server'
    );
  } catch {
    return false;
  }
}

async function assertReachable(url) {
  try {
    // Any answer will do: the build-free stack has no nginx to serve /healthz.
    await fetch(`${url}/healthz`);
  } catch (err) {
    throw new Error(
      `no server at ${url} (${err.cause?.code ?? err.message}). Bring the test ` +
        'stack up with `pnpm backend:test:up`, or pass --url.',
      { cause: err }
    );
  }
}

// ---------- scenarios ----------

async function benchmark(url, scale) {
  const { reps } = scale;
  // Scenarios that download a shared folder's attachments on every repetition.
  const heavyReps = Math.min(reps, 10);
  let noteCount = 0;
  const newNote = () => new BenchNote(noteCount++, scale.noteBytes);
  const closers = [];

  // --- auth ---
  const accounts = [];
  await time('auth.signup', 2, {
    run: async () => {
      const credentials = freshCredentials('owner');
      accounts.push({ credentials, account: await signup(url, credentials) });
    }
  });
  const owner = accounts.at(-1);
  await time('auth.login', 3, {
    run: async () => {
      const session = await login(url, owner.credentials);
      closers.push(() => session.logout());
    }
  });

  // --- vault sync, one device ---
  const devices = [];
  await time('sync.first', accounts.length, {
    before: () => accounts[devices.length].account,
    run: async (account) => {
      const device = new Device(url, account);
      await device.sync();
      devices.push(device);
    },
    detail: 'new account: create the vault collections'
  });
  const deviceA = devices.at(-1);
  closers.push(...devices.map((device) => () => device.logout()));

  await time('sync.idle', reps, {
    warmup: 1,
    run: () => deviceA.sync(),
    detail: 'scheduler tick, nothing changed'
  });

  const notes = [];
  await time('sync.push_new', reps, {
    before: newNote,
    run: (note) => deviceA.sync({ newNotes: [note] }),
    after: (note) => notes.push(note),
    detail: 'tick with one new note'
  });
  let cursor = 0;
  const nextNote = () => notes[cursor++ % notes.length];
  const editedNote = () => {
    const note = nextNote();
    note.edit();
    return note;
  };
  await time('sync.push_edit', reps, {
    before: editedNote,
    run: (note) => deviceA.sync({ editedNotes: [note] }),
    detail: 'tick with one edited note'
  });

  // --- bulk, push phase only ---
  for (const count of scale.bulkNotes) {
    await time(`bulk.push_new[${count}]`, count >= 1000 ? 1 : 2, {
      before: async () => ({
        collection: await deviceA.vaultCollection('notes'),
        batch: Array.from({ length: count }, newNote)
      }),
      run: ({ collection, batch }) =>
        deviceA.pushNotes(collection, { newNotes: batch }),
      after: ({ batch }) => notes.push(...batch),
      per: { count, unit: 'note' }
    });
  }
  await time(`bulk.push_edit[${scale.bulkEdits}]`, 2, {
    before: async () => ({
      collection: await deviceA.vaultCollection('notes'),
      batch: Array.from({ length: scale.bulkEdits }, editedNote)
    }),
    run: ({ collection, batch }) =>
      deviceA.pushNotes(collection, { editedNotes: batch }),
    per: { count: scale.bulkEdits, unit: 'note' }
  });

  // --- vault sync, second device ---
  const deviceB = await deviceA.secondDevice();
  await deviceB.sync();
  await time('sync.pull_edit', reps, {
    before: async () => deviceA.sync({ editedNotes: [editedNote()] }),
    run: () => deviceB.sync(),
    detail: "tick that receives another device's edit"
  });
  await time(`bulk.pull[${notes.length}]`, 3, {
    before: async () => {
      deviceB.vault.notes.stoken = null;
      return deviceB.vaultCollection('notes');
    },
    run: (collection) => deviceB.pull(deviceB.vault.notes, collection),
    per: { count: notes.length, unit: 'note' }
  });

  // --- assets ---
  for (const bytes of scale.assetBytes) {
    const pushAsset = async () =>
      deviceA.pushAssets(await deviceA.vaultCollection('assets'), [
        makeAsset(bytes)
      ]);
    await time(`asset.push[${fmtSize(bytes)}]`, 3, {
      before: async () => ({
        collection: await deviceA.vaultCollection('assets'),
        asset: makeAsset(bytes)
      }),
      run: ({ collection, asset }) => deviceA.pushAssets(collection, [asset])
    });
    await deviceB.pull(
      deviceB.vault.assets,
      await deviceB.vaultCollection('assets')
    );
    await time(`asset.pull[${fmtSize(bytes)}]`, 3, {
      before: async () => {
        await pushAsset();
        return deviceB.vaultCollection('assets');
      },
      run: (collection) => deviceB.pull(deviceB.vault.assets, collection)
    });
  }

  // --- what opening a note for live editing costs before the relay ---
  const liveNote = notes[0];
  await time('live.room_info', reps, {
    warmup: 1,
    run: () => deviceA.roomInfo(liveNote.uid),
    detail: 'personal note: fetch the per-note key'
  });

  const sharedNote = newNote();
  const scopeId = await deviceA.createShareScope({
    note: sharedNote,
    assetCount: scale.sharedAssets.count,
    assetBytes: scale.sharedAssets.bytes
  });
  const sharedFolder =
    `shared folder holding ${scale.sharedAssets.count} x ` +
    `${fmtSize(scale.sharedAssets.bytes)} attachments`;
  const writerKey = randomBytes(91).toString('base64');
  await time('sync.idle+share', reps, {
    warmup: 1,
    run: () => deviceA.sync(),
    detail: 'idle tick with one shared folder'
  });
  await time('live.room_info+share', heavyReps, {
    warmup: 1,
    run: () => deviceA.sharedRoomInfo(scopeId, sharedNote.uid, writerKey),
    detail: sharedFolder
  });

  // --- live rooms ---
  const builtIn = await hasBuiltInRooms(url);
  const transport = builtIn
    ? roomsTransport(deviceA, async () => {
        const note = newNote();
        const collection = await deviceA.vaultCollection('notes');
        await deviceA.pushNotes(collection, { newNotes: [note] });
        return { collectionUid: collection.uid, itemUid: note.uid };
      })
    : relayTransport(url);
  const liveScenarios = [
    'live.join',
    'live.open_note',
    'live.open_note+share',
    'relay.frame',
    'relay.fanout',
    'relay.throughput'
  ];
  let relayUp = true;
  try {
    (await transport.join(await transport.newRoom())).close();
  } catch (err) {
    relayUp = false;
    for (const name of liveScenarios) {
      run.skipped.push({ name, reason: err.message });
    }
  }

  if (relayUp) {
    const frame = randomBytes(128);
    /** Time from dialling the server to a peer already in the room hearing us. */
    const openRoom = async (room, listener) => {
      const peer = await transport.join(room);
      peer.send(frame);
      await listener.nextFrame();
      return peer;
    };
    /** A peer that is already in `room`, as the other editor would be. */
    const listenIn = async (room) => {
      const listener = await transport.join(room);
      const probe = await transport.join(room);
      await settle([probe, listener]);
      probe.close();
      closers.push(() => listener.close());
      return listener;
    };

    const joinRoomOnly = await transport.newRoom();
    const joinListener = await listenIn(joinRoomOnly);
    let joined = null;
    await time('live.join', reps, {
      run: async () => {
        joined = await openRoom(joinRoomOnly, joinListener);
      },
      after: () => joined.close(),
      detail: transport.joinDetail
    });

    const personalListener = await listenIn(
      transport.noteRoom(await deviceA.roomInfo(liveNote.uid))
    );
    await time('live.open_note', reps, {
      run: async () => {
        const room = transport.noteRoom(await deviceA.roomInfo(liveNote.uid));
        joined = await openRoom(room, personalListener);
      },
      after: () => joined.close(),
      detail: 'room_info + join, personal note'
    });

    const sharedListener = await listenIn(
      transport.noteRoom(
        await deviceA.sharedRoomInfo(scopeId, sharedNote.uid, writerKey)
      )
    );
    await time('live.open_note+share', heavyReps, {
      run: async () => {
        const room = transport.noteRoom(
          await deviceA.sharedRoomInfo(scopeId, sharedNote.uid, writerKey)
        );
        joined = await openRoom(room, sharedListener);
      },
      after: () => joined.close(),
      detail: `room_info + join, ${sharedFolder}`
    });

    const pair = [];
    const pairRoom = await transport.newRoom();
    for (let i = 0; i < 2; i++) pair.push(await transport.join(pairRoom));
    closers.push(...pair.map((peer) => () => peer.close()));
    await settle(pair);
    for (const bytes of [128, 16 * KIB]) {
      await roundTrips(pair, bytes, 10);
      record(
        `relay.frame[${fmtSize(bytes)}]`,
        summariseLatencies(await roundTrips(pair, bytes, scale.frames)),
        'one sender, one receiver'
      );
    }
    const started = performance.now();
    const rate = await throughput(...pair, 128, scale.throughputFrames);
    record(
      'relay.throughput[128 B]',
      summariseLatencies([performance.now() - started]),
      `${Math.round(rate).toLocaleString('en-US')} frames/s`
    );

    const crowd = [];
    const crowdRoom = await transport.newRoom();
    for (let i = 0; i < scale.fanoutPeers; i++) {
      crowd.push(await transport.join(crowdRoom));
    }
    closers.push(...crowd.map((peer) => () => peer.close()));
    await settle(crowd);
    record(
      `relay.fanout[${scale.fanoutPeers} peers]`,
      summariseLatencies(await roundTrips(crowd, 128, scale.frames)),
      'until every peer has the frame'
    );
  }

  // --- freeform ---
  // Freeform notes use the same rooms as every other kind, so relay.frame
  // covers them. The socket.io relay they once had is gone.
  run.skipped.push({
    name: 'freeform.frame',
    reason: 'freeform notes use the same rooms; see relay.frame'
  });

  for (const close of closers) {
    try {
      await close();
    } catch {
      // Best effort: a socket or session that is already gone is fine.
    }
  }
}

// ---------- entry ----------

async function main() {
  if (positionals[0] === 'diff') {
    if (positionals.length !== 3) {
      throw new Error('usage: run.mjs diff <baseline.json> <other.json>');
    }
    printComparison(loadRun(positionals[1]), loadRun(positionals[2]));
    return;
  }

  const scale = SCALES[args.scale];
  if (!scale) throw new Error(`--scale must be one of: ${Object.keys(SCALES)}`);
  const url = (
    args.url ??
    process.env.MINDSTREAM_E2E_BACKEND_URL ??
    'http://localhost:18080'
  ).replace(/\/$/, '');
  const rttMs = args.rtt ? Number(args.rtt) : 0;

  await assertReachable(url);
  installHttpMeter();
  run.meta = {
    label: args.label,
    url,
    scale: args.scale,
    startedAt: new Date().toISOString(),
    node: process.version,
    host: `${os.cpus()[0].model.trim()} x${os.cpus().length}, ${os.platform()}`
  };
  console.log(`benchmarking ${url} (${args.scale}) as "${args.label}"`);

  const idle = dockerFootprint(args['docker-project']);
  if (idle) run.footprint['before the run'] = idle;
  try {
    await benchmark(url, scale);
  } finally {
    closeHttpMeter();
  }
  const loaded = dockerFootprint(args['docker-project']);
  if (loaded) run.footprint['after the run'] = loaded;

  printResults(run, rttMs);
  const out = resolve(
    args.out ?? resolve(repoRoot, `.output/bench/backend/${args.label}.json`)
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`\nsaved ${out}`);

  if (args.compare) printComparison(loadRun(args.compare), run);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n${err.stack ?? err}`);
    if (err.status === 429 || /429/.test(String(err.message))) {
      console.error(
        '\nThe edge rate-limits auth to 10 requests a minute; wait a minute and rerun.'
      );
    }
    process.exit(1);
  }
);
