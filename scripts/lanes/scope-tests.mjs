// scripts/lanes/scope-tests.mjs
// The tests a drafted issue's Scope must add, so /plan-issues does not rely on its own grep.
//
//   node scripts/lanes/scope-tests.mjs --paths <path>... [--strings <text>...] [--new <path>...]
//
// Prints one line per test file: `<file>: <reason>`, where a reason is `affected by <path>` (affectedTests with the
// module map), `contains "<text>"` (a literal, case-sensitive search of every tracked `*.test.mjs` and test
// fixture) or `reads <path>` (a test that holds a non-.mjs --paths entry by path or file name). A path or string
// with no hit prints nothing. For each `--new` scripts/**/*.mjs file the issue will create it also prints
// `new <path>: <registration file>` lines: lanes.config.json when no module prefix claims the path, and two checks
// the planner decides, since a file that does not exist yet cannot be inspected. Exit 0, or 2 on bad arguments.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL, affectedTests } from "./affected-tests.mjs";
import { moduleOf } from "./modules.mjs";

const TEST_FILE = /\.test\.mjs$/;
const FIXTURE = /(\.fixtures?\.[^/]+$)|((^|\/)(__tests__|tests?|fixtures?)\/)/;

const USAGE = "usage: scope-tests.mjs --paths <path>... [--strings <text>...] [--new <path>...]";
const CHECK = "(check for the planner)";

/** `{ paths, strings, new }`, or null when the arguments are bad (no value, unknown flag, nothing to look up). */
export function parseArgs(argv) {
  const out = { "--paths": [], "--strings": [], "--new": [] };
  const seen = new Set();
  let current = null;
  for (const arg of argv) {
    if (arg in out) { current = out[arg]; seen.add(arg); }
    else if (arg.startsWith("--") || current === null || arg === "") return null;
    else current.push(arg);
  }
  const { "--paths": paths, "--strings": strings, "--new": created } = out;
  if (!seen.size || [...seen].some((flag) => !out[flag].length)) return null;
  return { paths, strings, new: created };
}

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).split("\0").filter(Boolean);
const readConfig = () => JSON.parse(readFileSync("lanes.config.json", "utf8"));
const readFile = (f) => readFileSync(f, "utf8");

/** `{ code, message }`: message is the `<file>: <reason>` lines. Tests pass fake I/O. */
export function main(argv, io = { readConfig, tracked, readFile }) {
  const args = parseArgs(argv);
  if (!args) return { code: 2, message: USAGE };
  let files, config;
  try {
    files = io.tracked();
    config = args.paths.length || args.new.length ? io.readConfig() : null;
  } catch (err) {
    return { code: 2, message: `scope-tests: ${err.message}` };
  }
  const reasons = new Map();
  const add = (file, reason) => reasons.set(file, [...(reasons.get(file) ?? []), reason]);

  for (const path of args.paths) {
    const hits = affectedTests({ changed: [path.replace(/\\/g, "/")], config, files });
    if (hits !== ALL) for (const f of hits) add(f, `affected by ${path}`);
  }
  if (args.strings.length) {
    for (const f of files.filter((p) => TEST_FILE.test(p) || FIXTURE.test(p)).sort()) {
      let text;
      try { text = io.readFile(f); } catch { continue; }
      for (const s of args.strings) if (text.includes(s)) add(f, `contains "${s}"`);
    }
  }
  // A doc (any non-.mjs path) can be pinned by a test that reads it, by full path or by file name (#715).
  for (const path of args.paths.map((p) => p.replace(/\\/g, "/")).filter((p) => !p.endsWith(".mjs"))) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const f of files.filter((p) => TEST_FILE.test(p)).sort()) {
      let text;
      try { text = io.readFile(f); } catch { continue; }
      if (text.includes(path) || text.includes(name)) add(f, `reads ${path}`);
    }
  }
  const lines = [...reasons].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, r]) => `${f}: ${r.join(", ")}`);
  // Checks for files the issue will create: they cannot be inspected yet, so the planner decides each one.
  for (const path of args.new.map((p) => p.replace(/\\/g, "/")).filter((p) => /^scripts\/.*\.mjs$/.test(p))) {
    if (config?.modules && moduleOf(path, config.modules) === null) lines.push(`new ${path}: lanes.config.json`);
    lines.push(`new ${path}: vendor/owasp-cheatsheets/INDEX.md if it imports node:child_process ${CHECK}`);
    lines.push(`new ${path}: .github/CODEOWNERS if queue.mjs will load it ${CHECK}`);
  }
  return { code: 0, message: lines.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  if (message) (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}
