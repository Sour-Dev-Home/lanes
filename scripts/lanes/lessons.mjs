// scripts/lanes/lessons.mjs
// Reviewer-found lessons (ADR 0011). Fragments in docs/lessons.d/ are the only source of truth: each is
// `<area>-<pattern>-<N>.md` with frontmatter and a lesson of one to three sentences, and a pattern's (xN) is the count
// of fragments sharing its area and pattern, computed here on read.
//
//   node scripts/lanes/lessons.mjs --paths <p...>      lessons for those paths' areas plus general, highest count first
//   node scripts/lanes/lessons.mjs --check             validates every fragment; exits 1 naming each bad file
//   node scripts/lanes/lessons.mjs --recurring [--min N]  patterns with at least N fragments (default 3), with files
//
// A fragment:
//   ---
//   area: general
//   pattern: typed-error-covers-every-step
//   severity: important
//   reviewer: test-hunter
//   source: "#12"
//   ---
//
//   One to three sentences.
//
// Area is the module id `moduleOf` gives from lanes.config.json's `modules` map, or `general` for a file no module
// claims; with no `modules` key it is the path's first segment. Exit codes: 0 ok, 1 an invalid fragment (--check
// only), 2 a bad argument, an unreadable config or directory, or a malformed module map.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleOf } from "./modules.mjs";

export const DIR = "docs/lessons.d";
export const MAX_PATTERNS = 20;
export const MAX_CHARS = 3000;
export const DEFAULT_MIN = 3;

const KEYS = ["area", "pattern", "severity", "reviewer", "source"];
const SEVERITIES = new Set(["critical", "important"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCE = /^#([1-9][0-9]*)$/;
const MAX_SENTENCES = 3;
const USAGE = "usage: lessons.mjs --paths <p...> | --check | --recurring [--min N]";

const normalize = (path) => String(path).replace(/\\/g, "/").replace(/^(\.\/)+/, "");

/** The lessons area of repo-relative `path`: its module id, `general` when no module claims it, or with no map its first segment. */
export function areaOf(path, map) {
  const p = normalize(path);
  if (map === undefined) return p.split("/")[0] || "general";
  return moduleOf(p, map) ?? "general";
}

/**
 * The entries of `dir` as `{ name, text, regular }`, or null when it does not exist. A symlink, directory or other
 * non-regular entry is listed with `regular: false` and never read, so a link cannot pull a file from outside the repo
 * into a reviewer's prompt.
 */
export function readFragments(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
  return entries.map((e) => (e.isFile() && !e.isSymbolicLink()
    ? { name: e.name, text: readFileSync(join(dir, e.name), "utf8"), regular: true }
    : { name: e.name, text: "", regular: false }));
}

const unquote = (v) => (/^"[^"]*"$|^'[^']*'$/.test(v) ? v.slice(1, -1) : v);

/** `{ fields, body }` from a fragment's text, or `{ error }` when its frontmatter cannot be read. */
function parse(text) {
  const src = String(text).replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) return { error: "no frontmatter (a --- block first)" };
  const fields = {};
  const problems = [];
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!kv) { problems.push(`malformed frontmatter line "${line.trim().slice(0, 60)}"`); continue; }
    const [, key, value] = kv;
    if (Object.hasOwn(fields, key)) problems.push(`duplicate key "${key}"`);
    else if (!KEYS.includes(key)) problems.push(`unknown key "${key}"`);
    fields[key] = unquote(value.trim());
  }
  return { fields, body: m[2].replace(/\s+/g, " ").trim(), problems };
}

/**
 * The sentences in `body`: a sentence ends at . ! or ? followed by space and a capital, digit, quote or backtick, or
 * at the end. Inline code is blanked first, so `String(err).message` or `e.g. this` do not split a sentence.
 */
function sentences(body) {
  const prose = body.replace(/`[^`]*`/g, "code").trim();
  if (!prose) return 0;
  return (prose.match(/[.!?]+["')\]]*\s+(?=[A-Z0-9`"'(])/g)?.length ?? 0) + 1;
}

/**
 * Validates each fragment from readFragments against `map` (the `modules` value, or undefined). Returns
 * `{ fragments: [{ file, area, pattern, severity, reviewer, source, n, body }], problems: [{ file, reason }] }`, with
 * every invalid fragment in `problems` only. Throws on a malformed map.
 */
export function checkFragments(list, map) {
  const ids = map === undefined ? null : (moduleOf("", map), new Set([...map.entries.map((e) => e.id), "general"]));
  const knownArea = (a) => (ids ? ids.has(a) : !a.includes("/") && !a.includes("\\") && a !== "." && a !== "..");
  const fragments = [];
  const problems = [];
  for (const { name, text, regular } of list ?? []) {
    const reasons = [];
    if (!regular) reasons.push("not a regular file");
    else if (!name.endsWith(".md")) reasons.push("not a .md fragment");
    else {
      const parsed = parse(text);
      if (parsed.error) reasons.push(parsed.error);
      else {
        const f = parsed.fields;
        reasons.push(...parsed.problems);
        for (const key of KEYS) if (!f[key]) reasons.push(`missing "${key}"`);
        if (f.area && !knownArea(f.area)) reasons.push(`unknown area "${f.area}"`);
        if (f.pattern && !SLUG.test(f.pattern)) reasons.push(`pattern "${f.pattern}" is not a kebab-case slug`);
        if (f.severity && !SEVERITIES.has(f.severity)) reasons.push(`severity "${f.severity}" must be critical or important`);
        const source = SOURCE.exec(f.source ?? "");
        if (f.source && !source) reasons.push(`source "${f.source}" must be "#N"`);
        if (f.area && f.pattern && source) {
          const expected = `${f.area}-${f.pattern}-${source[1]}.md`;
          if (name !== expected) reasons.push(`file name should be ${expected}`);
        }
        const count = sentences(parsed.body);
        if (count === 0) reasons.push("body is empty");
        else if (count > MAX_SENTENCES) reasons.push(`body has ${count} sentences (at most ${MAX_SENTENCES})`);
        if (!reasons.length) {
          fragments.push({ file: name, ...Object.fromEntries(KEYS.map((k) => [k, f[k]])), n: Number(source[1]), body: parsed.body });
        }
      }
    }
    if (reasons.length) problems.push({ file: name, reason: reasons.join("; ") });
  }
  problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { fragments, problems };
}

/** Patterns as `{ key, count, files, lesson }`, highest count first then by key; the lesson is the newest fragment's. */
function patterns(fragments) {
  const byKey = new Map();
  for (const f of fragments) {
    const key = `${f.area}/${f.pattern}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  return [...byKey].map(([key, fs]) => {
    fs.sort((a, b) => a.n - b.n || (a.file < b.file ? -1 : 1));
    return { key, count: fs.length, files: fs.map((f) => f.file), lesson: fs[fs.length - 1].body };
  }).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/**
 * The lessons for `paths`' areas plus general, one `(xN) area/pattern: lesson` line each, highest count first: at most
 * MAX_PATTERNS lines and MAX_CHARS characters, a line that would pass the budget being left out.
 */
export function lessonsFor(paths, fragments, map) {
  const areas = new Set(["general", ...paths.map((p) => areaOf(p, map))]);
  let out = "";
  let lines = 0;
  for (const p of patterns(fragments.filter((f) => areas.has(f.area)))) {
    if (lines === MAX_PATTERNS) break;
    const line = `(x${p.count}) ${p.key}: ${p.lesson}\n`;
    if (out.length + line.length > MAX_CHARS) continue;
    out += line;
    lines++;
  }
  return out;
}

/** One `(xN) area/pattern: file, file` line per pattern with at least `min` fragments. */
export function recurring(fragments, min = DEFAULT_MIN) {
  return patterns(fragments).filter((p) => p.count >= min).map((p) => `(x${p.count}) ${p.key}: ${p.files.join(", ")}\n`).join("");
}

function parseArgs(argv) {
  const modes = argv.filter((a) => ["--paths", "--check", "--recurring"].includes(a));
  if (modes.length !== 1 || argv[0] !== modes[0]) return { error: USAGE };
  const [mode, ...rest] = argv;
  if (mode === "--paths") {
    const flag = rest.find((a) => a.startsWith("--"));
    return flag ? { error: `unknown option ${flag}\n${USAGE}` } : { mode, paths: rest };
  }
  if (mode === "--check") return rest.length ? { error: USAGE } : { mode };
  if (rest.length === 0) return { mode, min: DEFAULT_MIN };
  if (rest[0] !== "--min" || rest.length !== 2) return { error: `--recurring takes only --min N\n${USAGE}` };
  if (!/^[1-9][0-9]*$/.test(rest[1])) return { error: `--min must be a positive integer, not "${rest[1]}"` };
  return { mode, min: Number(rest[1]) };
}

const readConfig = () => JSON.parse(readFileSync("lanes.config.json", "utf8"));

/** Runs one mode; returns `{ code, out, err }`. Tests pass fake I/O. */
export function main(argv, io = { readConfig, listFragments: () => readFragments(DIR) }) {
  const args = parseArgs(argv);
  if (args.error) return { code: 2, out: "", err: `lessons: ${args.error}\n` };
  let map;
  let list;
  try {
    let config = {};
    try {
      config = io.readConfig();
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`cannot read lanes.config.json: ${err.message}`);
    }
    map = config?.modules;
    if (map !== undefined) moduleOf("", map);
    list = io.listFragments();
  } catch (err) {
    return { code: 2, out: "", err: `lessons: ${err.message}\n` };
  }
  const { fragments, problems } = checkFragments(list, map);
  if (args.mode === "--check") {
    const summary = `lessons: ${fragments.length + problems.length} fragments, ${problems.length} invalid\n`;
    return { code: problems.length ? 1 : 0, out: summary, err: problems.map((p) => `${p.file}: ${p.reason}\n`).join("") };
  }
  const err = problems.length
    ? `lessons: skipped ${problems.length} invalid fragment${problems.length === 1 ? "" : "s"}; run lessons.mjs --check\n`
    : "";
  const out = args.mode === "--paths" ? lessonsFor(args.paths, fragments, map) : recurring(fragments, args.min);
  return { code: 0, out, err };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
