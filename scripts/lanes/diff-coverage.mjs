// scripts/lanes/diff-coverage.mjs
// The coverage of the lines a PR changes, for the test-hunter: it runs the test suite under Node's built-in coverage
// (`--experimental-test-coverage`, lcov reporter, no dependency), intersects the lcov line data with the added and
// changed lines of `git diff --unified=0 <base>...HEAD` for non-test `.mjs` files, and prints one summary line and
// then at most 30 `file:line` entries for the uncovered changed lines. It reports and never gates: exit 0 whatever
// the percentage, exit 2 with one line when coverage cannot be produced. The parsing and the intersection are pure;
// `main` takes its I/O as an argument so tests pass fixed input.
//
//   node scripts/lanes/diff-coverage.mjs                    # against origin/main
//   node scripts/lanes/diff-coverage.mjs --base main
//
// A changed line the coverage data does not list (a comment, a brace) is not executable and is left out of both
// counts. A changed file the tests never load has no data at all, so each of its lines except blanks and comments
// counts as uncovered.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_ENTRIES = 30;
const DEFAULT_BASE = "origin/main";
const TEST_GLOB = "scripts/**/*.test.mjs";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** `--base <ref>` (default origin/main); throws on anything else, and on a ref git would read as an option. */
export function parseArgs(argv) {
  const options = { base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      const value = argv[++i] ?? "";
      if (!value || value.startsWith("-")) throw new Error("--base needs a ref");
      options.base = value;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

/** Lcov text as `Map<source path, Map<line, hits>>`; only SF and DA records are read, and a repeated line adds up. */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("SF:")) {
      current = files.get(line.slice(3)) ?? new Map();
      files.set(line.slice(3), current);
    } else if (line.startsWith("DA:") && current) {
      const match = /^DA:(\d+),(\d+)/.exec(line);
      if (match) current.set(Number(match[1]), (current.get(Number(match[1])) ?? 0) + Number(match[2]));
    } else if (line === "end_of_record") current = null;
  }
  return files;
}

/** An lcov `SF:` path as a repo-relative path with forward slashes (an already relative path is kept). */
export function normalizeSf(sf, root) {
  const path = sf.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const windows = /^[a-z]:\//i.test(base);
  const head = path.slice(0, base.length);
  return (windows ? head.toLowerCase() === base.toLowerCase() : head === base) ? path.slice(base.length) : path;
}

/**
 * `git diff --unified=0` output as `Map<new path, [{ line, text }]>`: the added and changed lines by their new line
 * numbers. A deleted file, a pure deletion and a rename with no edits add nothing; a rename is keyed by its new path.
 * The hunk header's counts say how many lines belong to the hunk, so a removed line that reads `-- x` is not
 * mistaken for a `---` file header.
 */
export function parseDiff(text) {
  const files = new Map();
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const line of text.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) {
        newLeft--;
        if (file) files.get(file).push({ line: next, text: line.slice(1).replace(/\r$/, "") });
        next++;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      next = Number(hunk[2]);
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/\t$/, "");
      file = path.startsWith("b/") ? path.slice(2) : null;
      if (file && !files.has(file)) files.set(file, []);
    }
  }
  for (const [path, lines] of files) if (!lines.length) files.delete(path);
  return files;
}

/** Non-test `.mjs` files: the ones whose changed lines are measured. */
export const isCandidate = (path) => path.endsWith(".mjs") && !/\.test\.mjs$/.test(path);

const isBlankOrComment = (text) => /^\s*(\/\/.*)?$/.test(text);

/** `{ covered, total, uncovered: ["file:line", ...] }` over the changed lines of the candidate files. */
export function intersect(changed, coverage) {
  let covered = 0;
  let total = 0;
  const uncovered = [];
  for (const [file, lines] of changed) {
    if (!isCandidate(file)) continue;
    const hits = coverage.get(file);
    for (const { line, text } of lines) {
      if (hits ? !hits.has(line) : isBlankOrComment(text)) continue;
      total++;
      if (hits?.get(line) > 0) covered++;
      else uncovered.push(`${file}:${line}`);
    }
  }
  return { covered, total, uncovered };
}

/** The summary line, then at most MAX_ENTRIES uncovered lines and, past that, how many were left out. */
export function report({ covered, total, uncovered }) {
  const percent = total ? Math.round((covered / total) * 100) : 100;
  const lines = [`changed lines covered: ${covered} of ${total} (${percent}%)`, ...uncovered.slice(0, MAX_ENTRIES)];
  if (uncovered.length > MAX_ENTRIES) lines.push(`... and ${uncovered.length - MAX_ENTRIES} more`);
  return lines.join("\n");
}

/** Never throws: `{ code: 0, message }` with the report, or `{ code: 2, message }` with one line saying why not. */
export function main(argv = process.argv.slice(2), io = realIo) {
  const fail = (why) => ({ code: 2, message: `diff-coverage: ${String(why).split("\n")[0]}` });
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return fail(error.message);
  }
  try {
    const changed = parseDiff(io.diff(options.base));
    const raw = parseLcov(io.lcov());
    if (!raw.size) return fail("coverage could not be produced: no coverage data in the test run");
    const coverage = new Map([...raw].map(([sf, hits]) => [normalizeSf(sf, io.root), hits]));
    return { code: 0, message: report(intersect(changed, coverage)) };
  } catch (error) {
    return fail(`coverage could not be produced: ${error.message}`);
  }
}

const realIo = {
  root: process.cwd(),
  diff: (base) =>
    execFileSync("git", ["-c", "core.quotepath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", `${base}...HEAD`, "--"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }),
  // The lcov goes to stdout. A failing test still leaves data, so the exit status is not read; a run that could not
  // start, or was killed by the timeout, is an error. NODE_TEST_CONTEXT is dropped so a run started from inside a
  // test does not behave as a subtest.
  lcov: () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", "--test-reporter=lcov", TEST_GLOB], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: RUN_TIMEOUT_MS, env, stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.error) throw run.error;
    return run.stdout;
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main();
  console.log(message);
  process.exitCode = code;
}
