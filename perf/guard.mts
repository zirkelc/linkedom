/**
 * Characterisation guard: hashes the observable behaviour of every case against the working
 * tree and compares it with the recorded expectations.
 *
 *   node --import tsx perf/guard.mts            check, exit 1 on any difference
 *   node --import tsx perf/guard.mts --update   record expectations (only before the first experiment)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKTREE, fnv1a, loadCases, loadConfig, materialise } from "./harness.mts";

const HARNESS_DIR = import.meta.dirname;
const { config, values } = loadConfig(HARNESS_DIR, process.argv.slice(2), {
  update: { type: "boolean" },
  expected: { type: "string" },
});

const expectedPath = path.resolve((values.expected as string | undefined) ?? path.join(HARNESS_DIR, "guard-expected.json"));
const cases = await loadCases(config, materialise(config, WORKTREE, "guard"));

/** Error objects serialize to `{}`, so capture their observable parts explicitly. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) return { name: value.name, message: value.message, ...(value as any) };
  if (value instanceof Map) return { __map: [...value.entries()] };
  if (value instanceof Set) return { __set: [...value.values()] };
  return value;
}

const actual: Record<string, { hash: string; bytes: number }> = {};
for (const c of cases) {
  let sample: unknown;
  try {
    c.setup?.();
    sample = c.collect();
  } catch (error) {
    sample = { __threw: replacer("", error) };
  } finally {
    c.teardown?.();
  }
  const json = JSON.stringify(sample, replacer);
  actual[c.name] = { hash: fnv1a(json), bytes: json.length };
}

if (values.update) {
  fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), expectedPath)} (${Object.keys(actual).length} cases)`);
  process.exit(0);
}

if (!fs.existsSync(expectedPath)) {
  console.error(`No expectations at ${expectedPath}. Run once with --update before the first experiment.`);
  process.exit(2);
}

const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
let failed = false;
for (const name of names) {
  const e = expected[name];
  const a = actual[name];
  if (!e || !a || e.hash !== a.hash || e.bytes !== a.bytes) {
    failed = true;
    console.error(`MISMATCH ${name}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}
if (failed) {
  console.error("guard FAILED: observable behaviour changed");
  process.exit(1);
}
console.log(`guard OK (${names.size} cases)`);
