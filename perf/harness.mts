/**
 * Shared helpers for the node-ts autoresearch harness: configuration, revision
 * materialisation, case loading and deterministic data helpers.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One benchmark workload. */
export interface PerfCase {
  /** Stable name, used as the key in reports and in the guard file. */
  name: string;
  /** Timed body. Must be deterministic and side-effect free across calls. */
  run: () => void;
  /** Serializable sample of observable behaviour, hashed by the guard. */
  collect: () => unknown;
  /** Optional: create and return one retained instance, measured by the memory harness. */
  alloc?: () => unknown;
}

/** A cases module exports this function. It receives the module namespace of the entry point. */
export type BuildCases = (lib: any) => Array<PerfCase>;

/** Pseudo revision that means "the working tree as it is on disk". */
export const WORKTREE = "WORKTREE";

export interface HarnessConfig {
  /** Absolute repo root. */
  root: string;
  /** Entry point, relative to the repo root (for example `packages/lib/src/index.ts`). */
  entry: string;
  /** Paths archived per revision, relative to the repo root. */
  src: Array<string>;
  /** Cases module, relative to the repo root. */
  cases: string;
}

const CONFIG_FILE = "perf.config.json";

/**
 * Reads `perf.config.json` next to the harness scripts, then applies CLI flags on top.
 * Returns the resolved config and the remaining positional arguments.
 */
export function loadConfig(
  harnessDir: string,
  argv: Array<string>,
  extraOptions: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {}
): { config: HarnessConfig; positionals: Array<string>; values: Record<string, any> } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      entry: { type: "string" },
      src: { type: "string", multiple: true },
      cases: { type: "string" },
      ...extraOptions,
    },
  });

  const configPath = path.join(harnessDir, CONFIG_FILE);
  const fileConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: harnessDir }).toString().trim();
  const entry = (values.entry as string | undefined) ?? fileConfig.entry;
  const src = (values.src as Array<string> | undefined) ?? fileConfig.src;
  const cases = (values.cases as string | undefined) ?? fileConfig.cases ?? path.relative(root, path.join(harnessDir, "cases.mts"));

  if (!entry || !src?.length) {
    throw new Error(`Set "entry" and "src" in ${configPath} or pass --entry and --src.`);
  }
  return { config: { root, entry, src, cases }, positionals, values };
}

/**
 * Unpacks `src` paths of `rev` into `.perf-trees/<sha>-<slot>` inside the repo and returns
 * the absolute entry path in that tree. The tree lives inside the repo because Node resolves
 * dependencies by walking up from the importing file. One directory per slot means that
 * comparing a revision with itself still loads two separate module instances.
 */
export function materialise(config: HarnessConfig, rev: string, slot: string): string {
  if (rev === WORKTREE) return path.join(config.root, config.entry);

  const sha = execFileSync("git", ["rev-parse", `${rev}^{commit}`], { cwd: config.root }).toString().trim();
  const treesDir = path.join(config.root, ".perf-trees");
  const dir = path.join(treesDir, `${sha}-${slot}`);

  if (!fs.existsSync(dir)) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.mkdirSync(tmp, { recursive: true });
    const tar = execFileSync("git", ["archive", "--format=tar", sha, "--", ...config.src], {
      cwd: config.root,
      maxBuffer: 1 << 30,
    });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    linkNodeModules(config, tmp);
    fs.renameSync(tmp, dir);
  }
  return path.join(dir, config.entry);
}

/**
 * Workspace packages often keep their own `node_modules` next to their sources. The unpacked
 * tree does not contain them, so link every `node_modules` that exists between a source path
 * and the repo root. The root `node_modules` is reached by normal upward resolution.
 */
function linkNodeModules(config: HarnessConfig, treeDir: string): void {
  for (const src of config.src) {
    let rel = path.dirname(src);
    while (rel && rel !== "." && rel !== path.sep) {
      const real = path.join(config.root, rel, "node_modules");
      const link = path.join(treeDir, rel, "node_modules");
      if (fs.existsSync(real) && !fs.existsSync(link) && fs.existsSync(path.dirname(link))) {
        fs.symlinkSync(real, link, "dir");
      }
      rel = path.dirname(rel);
    }
  }
}

/** Imports the entry module and builds the cases against it. */
export async function loadCases(config: HarnessConfig, entryPath: string): Promise<Array<PerfCase>> {
  const lib = await import(pathToFileURL(entryPath).href);
  const casesModule = await import(pathToFileURL(path.join(config.root, config.cases)).href);
  const build: BuildCases | undefined = casesModule.buildCases;
  if (typeof build !== "function") throw new Error(`${config.cases} must export buildCases(lib).`);
  return build(lib);
}

/** mulberry32 PRNG, for seeded and reproducible benchmark inputs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Wall-clock duration of `fn` in nanoseconds. */
export function timeNs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start);
}
