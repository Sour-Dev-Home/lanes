// scripts/lanes/affected-tests.mjs
// The test files a diff needs (ADR 0017), or `ALL` when the diff cannot be narrowed safely. Fails safe: anything
// unexpected prints ALL, never a smaller set.
//
//   node scripts/lanes/affected-tests.mjs <base-ref>
//
// A changed file selects the `*.test.mjs` files of the module owning it (lanes.config.json `modules`) and of every
// module that imports that module, directly or transitively. ALL is printed when a changed file maps to no module,
// is under .github/ or contracts/, is package.json, package-lock.json or lanes.config.json, is a test helper or
// fixture, when the diff fails or is empty, or when `ci.affectedTests` is false (a missing `ci` key means true).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listFiles, moduleOf } from "./modules.mjs";

export const ALL = "ALL";

const ALWAYS_ALL = /^(\.github\/|contracts\/|package\.json$|package-lock\.json$|lanes\.config\.json$)/;
const FIXTURE = /\.fixtures\.m?[jt]sx?$/;
const TEST_DIR = /(^|\/)(__tests__|tests?)\//;
const TEST_FILE = /\.test\.mjs$/;

const forcesAll = (path) =>
  ALWAYS_ALL.test(path) || FIXTURE.test(path) || (TEST_DIR.test(path) && !/\.test\.m?[jt]sx?$/.test(path));

/**
 * The sorted test files affected by `changed` (repo-relative POSIX paths), or "ALL". `files` is every repo file that
 * may be a test. Never throws: a malformed config or map is "ALL".
 */
export function affectedTests({ changed, config, files }) {
  try {
    if (config?.ci?.affectedTests === false) return ALL;
    const map = config?.modules;
    const entries = map?.entries;
    if (!Array.isArray(entries) || !changed.length) return ALL;
    const owners = new Set();
    for (const path of changed) {
      if (forcesAll(path)) return ALL;
      const id = moduleOf(path, map);
      if (id === null) return ALL;
      owners.add(id);
    }
    // Reverse import edges, then walk from the owners; a visited set ends any cycle.
    const importers = new Map();
    for (const e of entries) for (const dep of e.imports ?? []) importers.set(dep, [...(importers.get(dep) ?? []), e.id]);
    const affected = new Set(owners);
    const pending = [...owners];
    while (pending.length) {
      for (const id of importers.get(pending.pop()) ?? []) if (!affected.has(id)) { affected.add(id); pending.push(id); }
    }
    const tests = [...new Set(files.filter((f) => TEST_FILE.test(f) && affected.has(moduleOf(f, map))))].sort();
    return tests.length ? tests : ALL;
  } catch {
    return ALL;
  }
}

const readConfig = () => JSON.parse(readFileSync("lanes.config.json", "utf8"));
const gitDiff = (base) =>
  execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Every file in the directories the map's path prefixes live in, where its tests are.
function candidateFiles(config, list) {
  const dirs = new Set(config.modules.entries.flatMap((e) =>
    (e.paths ?? []).map((p) => String(p).slice(0, String(p).lastIndexOf("/") + 1))));
  return [...dirs].flatMap((d) => list(d));
}

/** `{ code, message }`: message is the test files, one per line, or ALL. Always code 0; tests pass fake I/O. */
export function main(argv, io = { diff: gitDiff, readConfig, listFiles }) {
  const all = { code: 0, message: ALL };
  const base = argv[0];
  // A leading "-" would be read by git as an option, so such a ref is refused before git runs.
  if (typeof base !== "string" || !base || base.startsWith("-")) return all;
  try {
    const config = io.readConfig();
    if (config?.ci?.affectedTests === false) return all;
    const changed = io.diff(base).split(/\r?\n/).filter(Boolean);
    const result = affectedTests({ changed, config, files: candidateFiles(config, io.listFiles) });
    return { code: 0, message: result === ALL ? ALL : result.join("\n") };
  } catch {
    return all;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  console.log(message);
  process.exitCode = code;
}
