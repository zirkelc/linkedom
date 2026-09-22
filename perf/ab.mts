/**
 * Paired A/B timing of two git revisions.
 *
 *   node --import tsx perf/ab.mts [revA=HEAD] [revB=WORKTREE] [--iters 25] [--repeats 2]
 *
 * Both revisions are imported into one process and timed in strict alternation, taking the
 * minimum per case. Module instances carry a stable load-order bias, so every measurement
 * runs in child processes for both load orders, and the orders are combined with a
 * geometric mean. Negative delta = revB is faster.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type PerfCase, WORKTREE, loadCases, loadConfig, materialise, timeNs } from "./harness.mts";

interface Row {
  name: string;
  /** Minimum ns per case body for the module loaded first. */
  first: number;
  /** Minimum ns per case body for the module loaded second. */
  second: number;
}

const HARNESS_DIR = import.meta.dirname;
const { config, positionals, values } = loadConfig(HARNESS_DIR, process.argv.slice(2), {
  iters: { type: "string" },
  warmup: { type: "string" },
  "target-ms": { type: "string" },
  repeats: { type: "string" },
  child: { type: "boolean" },
});

const ITERS = Number(values.iters ?? 15);
const WARMUP = Number(values.warmup ?? 2);
const TARGET_NS = Number(values["target-ms"] ?? 1.5) * 1_000_000;
const REPEATS = Number(values.repeats ?? 2);

/** Runs inside a child process: times the two entries loaded in the given order. */
async function measure(entryFirst: string, entrySecond: string): Promise<Array<Row>> {
  const casesFirst = await loadCases(config, entryFirst);
  const casesSecond = await loadCases(config, entrySecond);
  const rows: Array<Row> = [];

  for (let i = 0; i < casesFirst.length; i++) {
    const a: PerfCase = casesFirst[i];
    const b: PerfCase = casesSecond[i];
    if (a.name !== b.name) throw new Error(`Case order differs: ${a.name} vs ${b.name}`);

    /** JIT warm-up on the raw bodies, then size each timed run to about TARGET_NS. */
    let probe = Number.POSITIVE_INFINITY;
    /** Slow cases need fewer probe runs to warm up: stop early once one body takes over 20 ms. */
    for (let w = 0; w < 10 && !(w >= 3 && probe > 20_000_000); w++) {
      probe = Math.min(probe, timeNs(a.run));
      b.run();
    }
    const reps = Math.max(1, Math.round(TARGET_NS / probe));
    const runA = () => {
      for (let r = 0; r < reps; r++) a.run();
    };
    const runB = () => {
      for (let r = 0; r < reps; r++) b.run();
    };

    for (let w = 0; w < WARMUP; w++) {
      runA();
      runB();
    }
    let minA = Number.POSITIVE_INFINITY;
    let minB = Number.POSITIVE_INFINITY;
    for (let iter = 0; iter < ITERS; iter++) {
      if (iter % 2 === 0) {
        minA = Math.min(minA, timeNs(runA));
        minB = Math.min(minB, timeNs(runB));
      } else {
        minB = Math.min(minB, timeNs(runB));
        minA = Math.min(minA, timeNs(runA));
      }
    }
    rows.push({ name: a.name, first: minA / reps, second: minB / reps });
  }
  return rows;
}

function child(entryFirst: string, entrySecond: string): Array<Row> {
  const self = fileURLToPath(import.meta.url);
  const passthrough = ["--iters", String(ITERS), "--warmup", String(WARMUP), "--target-ms", String(TARGET_NS / 1_000_000)];
  const res = spawnSync(
    process.execPath,
    [...process.execArgv, self, "--child", ...passthrough, "--entry", config.entry, "--cases", config.cases, ...config.src.flatMap((s) => ["--src", s]), entryFirst, entrySecond],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (res.status !== 0) throw new Error(`child failed:\n${res.stderr}`);
  const lines = res.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

/** Per-case minimum across repeated children of the same load order. */
function minRows(runs: Array<Array<Row>>): Array<Row> {
  return runs[0].map((row, i) => ({
    name: row.name,
    first: Math.min(...runs.map((r) => r[i].first)),
    second: Math.min(...runs.map((r) => r[i].second)),
  }));
}

if (values.child) {
  const rows = await measure(positionals[0], positionals[1]);
  console.log(JSON.stringify(rows));
} else {
  const revA = positionals[0] ?? "HEAD";
  const revB = positionals[1] ?? WORKTREE;
  const entryA = materialise(config, revA, "a");
  const entryB = materialise(config, revB, "b");

  /** orderAB: A loaded first. orderBA: B loaded first. */
  const orderAB = minRows(Array.from({ length: REPEATS }, () => child(entryA, entryB)));
  const orderBA = minRows(Array.from({ length: REPEATS }, () => child(entryB, entryA)));

  const ms = (ns: number) => (ns / 1_000_000).toFixed(4).padStart(10);
  const pct = (ratio: number) => `${((ratio - 1) * 100).toFixed(2).padStart(7)}%`;
  const speedup = (ratio: number) => `${(1 / ratio).toFixed(2).padStart(6)}x`;

  console.log(`A = ${revA}, B = ${revB} (min of ${ITERS} iters, ${REPEATS} children x 2 load orders, ms)`);
  console.log(`${"case".padEnd(26)}${"A".padStart(10)}${"B".padStart(10)}${"delta".padStart(9)}${"speed".padStart(8)}`);

  let sumA = 0;
  let sumB = 0;
  const totals = { abA: 0, abB: 0, baA: 0, baB: 0 };
  for (let i = 0; i < orderAB.length; i++) {
    const ab = orderAB[i];
    const ba = orderBA[i];
    const ratio = Math.sqrt((ab.second / ab.first) * (ba.first / ba.second));
    const a = (ab.first + ba.second) / 2;
    sumA += a;
    sumB += a * ratio;
    totals.abA += ab.first;
    totals.abB += ab.second;
    totals.baB += ba.first;
    totals.baA += ba.second;
    console.log(`${ab.name.padEnd(26)}${ms(a)}${ms(a * ratio)} ${pct(ratio)}${speedup(ratio)}`);
  }
  const totalRatio = Math.sqrt((totals.abB / totals.abA) * (totals.baB / totals.baA));
  console.log(`${"TOTAL".padEnd(26)}${ms(sumA)}${ms(sumA * totalRatio)} ${pct(totalRatio)}${speedup(totalRatio)}`);
}
