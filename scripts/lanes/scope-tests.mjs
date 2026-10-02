// scripts/lanes/scope-tests.mjs
// The tests a drafted issue's Scope must add, so /plan-issues does not rely on its own grep.
//
//   node scripts/lanes/scope-tests.mjs --paths <path>... [--strings <text>...]
//
// Prints one line per test file: `<file>: <reason>`, where a reason is `affected by <path>` (affectedTests with the
// module map) or `contains "<text>"` (a literal, case-sensitive search of every tracked `*.test.mjs` and test
// fixture). A path or string with no hit prints nothing. Exit 0, or 2 on bad arguments.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL, affectedTests } from "./affected-tests.mjs";

const TEST_FILE = /\.test\.mjs$/;
const FIXTURE = /(\.fixtures?\.[^/]+$)|((^|\/)(__tests__|tests?|fixtures?)\/)/;

const USAGE = "usage: scope-tests.mjs --paths <path>... [--strings <text>...]";

/** `{ paths, strings }`, or null when the arguments are bad (no value, unknown flag, nothing to look up). */
export function parseArgs(argv) {
  const out = { "--paths": [], "--strings": [] };
  const seen = new Set();
  let current = null;
  for (const arg of argv) {
    if (arg === "--paths" || arg === "--strings") { current = out[arg]; seen.add(arg); }
    else if (arg.startsWith("--") || current === null || arg === "") return null;
    else current.push(arg);
  }
  const { "--paths": paths, "--strings": strings } = out;
  if (!seen.size || [...seen].some((flag) => !out[flag].length)) return null;
  return { paths, strings };
}

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
const readConfig = () => JSON.parse(readFileSync("lanes.config.json", "utf8"));
const readFile = (f) => readFileSync(f, "utf8");

/** `{ code, message }`: message is the `<file>: <reason>` lines. Tests pass fake I/O. */
export function main(argv, io = { readConfig, tracked, readFile }) {
  const args = parseArgs(argv);
  if (!args) return { code: 2, message: USAGE };
  let files, config;
  try {
    files = io.tracked();
    config = args.paths.length ? io.readConfig() : null;
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
  const lines = [...reasons].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, r]) => `${f}: ${r.join(", ")}`);
  return { code: 0, message: lines.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  if (message) (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}
