// scripts/lanes/structure-report.mjs
// The structural report /health reads (ADR 0008): the module map's results (violations, cycles, unmapped files), the
// files that grew fastest, the lane hotspots, and optionally a duplicate-code summary. The parsing and ranking are
// pure; `main` takes its I/O as an argument so tests pass fixed input.
//
//   node scripts/lanes/structure-report.mjs                    # last 7 days
//   node scripts/lanes/structure-report.mjs --days 30 --jscpd  # also runs jscpd through npx
//
// Both rankings read `git log --first-parent --numstat` of HEAD over the window. Growth sums the lines each commit
// added. A hotspot counts lane merges: a merge commit naming an `issue-<n>` branch, or, since lanes merges squash
// only, a single-parent commit whose subject ends in the PR number GitHub appends, `(#N)`.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main as modulesMain } from "./modules.mjs";

export const GIT_LOG_FORMAT = "%x1e%P%x1f%s";
// Pinned: npx --yes installs whatever it is told without asking, so the version is fixed here, not left to "latest".
export const JSCPD_PACKAGE = "jscpd@5.3.3";
const TOP = 10;
const TOP_CLONES = 5;

/** `--days N` (1 to 365, default 7) and `--jscpd`; throws on anything else. */
export function parseArgs(argv) {
  const options = { days: 7, jscpd: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jscpd") options.jscpd = true;
    else if (argv[i] === "--days") {
      const value = argv[++i] ?? "";
      options.days = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(options.days >= 1 && options.days <= 365)) throw new Error("--days must be a whole number from 1 to 365");
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

/**
 * Commits from `git log --numstat --format=<GIT_LOG_FORMAT>` output: `{ parents, subject, files: [{ path, added,
 * deleted }] }`. A binary file's `-` counts as 0 lines; a line that is not `added<TAB>deleted<TAB>path` is skipped.
 */
export function parseLog(text) {
  const commits = [];
  for (const record of String(text ?? "").split("\x1e").slice(1)) {
    const [header, ...rest] = record.split(/\r?\n/);
    const sep = header.indexOf("\x1f");
    const parents = header.slice(0, sep < 0 ? header.length : sep).trim();
    const files = [];
    for (const line of rest) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    commits.push({ parents: parents ? parents.split(/\s+/).length : 0, subject: sep < 0 ? "" : header.slice(sep + 1), files });
  }
  return commits;
}

/** A merge commit naming an `issue-<n>` branch, or a squash-merged PR commit (one parent, subject ending `(#N)`). */
export function isLaneMerge(commit) {
  if (commit.parents >= 2) return /(^|[\s/'"])issue-\d+/.test(commit.subject);
  return commit.parents === 1 && /\(#\d+\)\s*$/.test(commit.subject);
}

/** The top `n` of a path -> count map, most first, ties by path. Zero counts are left out. */
function top(counts, n) {
  return [...counts]
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, n)
    .map(([path, count]) => ({ path, count }));
}

/** The files with the most lines added across `commits`, as `[{ path, count }]`. */
export function rankGrowth(commits, n = TOP) {
  const counts = new Map();
  for (const c of commits) for (const f of c.files) counts.set(f.path, (counts.get(f.path) ?? 0) + f.added);
  return top(counts, n);
}

/** The files touched by the most lane merges (each merge counts a file once), as `[{ path, count }]`. */
export function rankHotspots(commits, n = TOP) {
  const counts = new Map();
  for (const c of commits.filter(isLaneMerge)) {
    for (const path of new Set(c.files.map((f) => f.path))) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return top(counts, n);
}

const slash = (p) => String(p).replaceAll("\\", "/");
const where = (f) => `${slash(f.name)}:${f.start}-${f.end}`;

/** One summary line from jscpd's JSON report, then its largest clones by file and line range. Throws if malformed. */
export function summarizeJscpd(report) {
  const t = report?.statistics?.total;
  if (!t || !Number.isFinite(t.clones)) throw new Error("jscpd report has no statistics.total");
  const lines = [`duplicates: ${t.clones} clones, ${t.duplicatedLines} duplicated lines (${Number(t.percentage).toFixed(1)}%) in ${t.sources} files`];
  const clones = (Array.isArray(report.duplicates) ? report.duplicates : [])
    .filter((d) => d?.firstFile && d?.secondFile)
    .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));
  for (const d of clones.slice(0, TOP_CLONES)) lines.push(`  ${d.lines} lines: ${where(d.firstFile)} ~ ${where(d.secondFile)}`);
  return lines.join("\n");
}

const ranking = (title, rows, show) => [`${title}:`, ...(rows.length ? rows.map((r) => `  ${show(r)}`) : ["  none"])];

/** Returns `{ code, message }`: 0 with the report, 2 on a bad argument or a failed git log. Tests pass fake I/O. */
export function main(argv = process.argv.slice(2), io = realIo) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    return { code: 2, message: `structure-report: ${err.message}` };
  }
  let commits;
  try {
    commits = parseLog(io.gitLog(options.days));
  } catch (err) {
    return { code: 2, message: `structure-report: git log failed: ${firstLine(err)}` };
  }
  const lines = [`structure report, last ${options.days} days`, io.modules().message];
  lines.push(...ranking("fastest-growing files (lines added)", rankGrowth(commits), (r) => `+${r.count} ${r.path}`));
  lines.push(...ranking("lane hotspots (lane merges touching the file)", rankHotspots(commits), (r) => `${r.count} ${r.path}`));
  if (!options.jscpd) lines.push("duplicates: not run (pass --jscpd)");
  else {
    try {
      lines.push(summarizeJscpd(io.jscpd()));
    } catch (err) {
      lines.push(`duplicates: skipped (${firstLine(err)})`);
    }
  }
  return { code: 0, message: lines.join("\n") };
}

const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0].trim();

const JSCPD_OUT = ".lanes/jscpd";
const JSCPD_ARGS = [
  "--yes", JSCPD_PACKAGE, "--silent", "--format", "javascript,typescript,jsx,tsx",
  "--ignore", "**/node_modules/**,**/vendor/**,**/.claude/worktrees/**", "--reporters", "json", "--output", JSCPD_OUT, ".",
];

const realIo = {
  gitLog: (days) => execFileSync("git", [
    "-c", "core.quotePath=false", "log", "--first-parent", "--diff-merges=first-parent", "--no-renames", "--numstat",
    `--since=${days}.days.ago`, `--format=${GIT_LOG_FORMAT}`, "HEAD",
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }),
  modules: () => modulesMain(),
  jscpd: () => {
    try {
      // npx is a .cmd shim on Windows, which execFile cannot start without a shell. Every argument is a constant
      // above, quoted here, so nothing from outside reaches that shell.
      const opts = { stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 };
      if (process.platform === "win32") execFileSync(`npx ${JSCPD_ARGS.map((a) => `"${a}"`).join(" ")}`, { ...opts, shell: true });
      else execFileSync("npx", JSCPD_ARGS, opts);
      return JSON.parse(readFileSync(`${JSCPD_OUT}/jscpd-report.json`, "utf8"));
    } finally {
      rmSync(JSCPD_OUT, { recursive: true, force: true });
    }
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main();
  console.log(message);
  process.exitCode = code;
}
