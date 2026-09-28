// scripts/lanes/modules.mjs
// The module map checker (ADR 0008). `checkModules` is pure: given the map and file contents it reports imports that
// cross a boundary the map does not allow, every import cycle, and files no module claims. `main` is the only I/O.
//
// The `modules` key of lanes.config.json (absent: no check):
//   {
//     "entries": [{ "id": "lanes", "paths": ["scripts/lanes/"], "imports": ["shared"] }, ...],
//     "allowCycles": [["scripts/lanes/pick.mjs", "scripts/lanes/status.mjs"]]
//   }
// `paths` are repo-relative path prefixes; the longest matching prefix decides a file's module. `imports` names the
// other modules it may import from (its own is always allowed). An `allowCycles` entry matches a cycle with exactly
// those files, in any order; an allowed cycle is still reported, under `allowedCycles`.
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = /\.(m?js|jsx|m?ts|tsx)$/;
const SKIP_DIRS = /(^|\/)(node_modules|\.git)\//;
// After one of these, a `/` starts a regex literal rather than a division.
const REGEX_AFTER_NAME = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
// A `(` right after one of these opens a control-flow header, not a call or grouping; a `/` right after its matching
// `)` starts a new statement, so a regex literal (not division) may follow (`if (x) /re/.test(s)`).
const CONTROL_KEYWORD = new Set(["if", "while", "for", "switch", "catch", "with"]);

/**
 * Splits JS source into name, string and punctuation tokens, dropping comments, regex literals and template text,
 * so import-like text inside them is never read as an import. A template with no `${}` is a string token.
 */
function tokenize(src) {
  const tokens = [];
  const braces = []; // one entry per open `{`: true when it is a template's `${`
  const parens = []; // one entry per open `(`: true when it follows a control-flow keyword
  let i = 0;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === "name") return REGEX_AFTER_NAME.has(t.value);
    if (t.type === "punct") return t.value === ")" ? !!t.control : !")]}".includes(t.value);
    return false;
  };
  // Reads template text from i (just past "`" or a closing "}") to its end or to the next "${".
  const templateText = () => {
    let text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { text += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { i++; return { text, closed: true }; }
      if (c === "$" && src[i + 1] === "{") { i += 2; braces.push(true); return { text, closed: false }; }
      text += c;
      i++;
    }
    return { text, closed: true };
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === "/" && regexAllowed()) {
      let inClass = false;
      for (i++; i < src.length && src[i] !== "\n"; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      tokens.push({ type: "regex" });
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) {
        if (src[i] === "\\") i++;
        value += src[i];
      }
      i++;
      tokens.push({ type: "string", value });
      continue;
    }
    if (c === "`") {
      i++;
      const { text, closed } = templateText();
      tokens.push(closed ? { type: "string", value: text } : { type: "template" });
      continue;
    }
    if (c === "(") { parens.push(last()?.type === "name" && CONTROL_KEYWORD.has(last().value)); tokens.push({ type: "punct", value: c }); i++; continue; }
    if (c === ")") { tokens.push({ type: "punct", value: c, control: parens.pop() ?? false }); i++; continue; }
    if (c === "{") { braces.push(false); tokens.push({ type: "punct", value: c }); i++; continue; }
    if (c === "}") {
      i++;
      if (braces.pop()) { templateText(); tokens.push({ type: "template" }); continue; }
      tokens.push({ type: "punct", value: c });
      continue;
    }
    const name = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i, i + 256));
    if (name) { tokens.push({ type: "name", value: name[0] }); i += name[0].length; continue; }
    tokens.push({ type: "punct", value: c });
    i++;
  }
  return tokens;
}

const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

/**
 * The relative ESM specifiers in `src`, in source order: `import … from "x"`, `import "x"`, `export … from "x"` and
 * `import("x")` with a string literal. Bare (`node:fs`, packages) and absolute specifiers are left out.
 */
export function importSpecifiers(src) {
  const t = tokenize(String(src ?? ""));
  const specs = [];
  const is = (k, type, value) => t[k]?.type === type && (value === undefined || t[k].value === value);
  for (let k = 0; k < t.length; k++) {
    if (t[k].type !== "name" || is(k - 1, "punct", ".")) continue;
    let spec;
    if (t[k].value === "from" && is(k + 1, "string")) spec = t[k + 1].value;
    else if (t[k].value === "import" && is(k + 1, "string")) spec = t[k + 1].value;
    else if (t[k].value === "import" && is(k + 1, "punct", "(") && is(k + 2, "string") && (is(k + 3, "punct", ")") || is(k + 3, "punct", ","))) {
      spec = t[k + 2].value;
    }
    if (spec !== undefined && isRelative(spec)) specs.push(spec);
  }
  return specs;
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Validates the `modules` value of lanes.config.json; throws with the reason. */
function compileMap(map) {
  const where = "lanes.config.json: modules";
  if (map === null || typeof map !== "object" || Array.isArray(map)) throw new Error(`${where} must be an object`);
  if (!Array.isArray(map.entries)) throw new Error(`${where}.entries must be an array`);
  const ids = new Set();
  for (const [n, e] of map.entries.entries()) {
    if (typeof e?.id !== "string" || !e.id) throw new Error(`${where}.entries[${n}].id must be a non-empty string`);
    if (ids.has(e.id)) throw new Error(`${where}: duplicate module id "${e.id}"`);
    ids.add(e.id);
    if (!isStringArray(e.paths) || e.paths.length === 0 || e.paths.some((p) => !p)) {
      throw new Error(`${where}.entries[${n}].paths must be a non-empty array of path prefixes`);
    }
    // main() scans the directories these name, so each must stay inside the repo.
    const outside = e.paths.find((p) => /^([\\/]|[a-z]:)/i.test(p) || p.includes("\\") || p.split("/").includes(".."));
    if (outside !== undefined) throw new Error(`${where}.entries[${n}].paths: "${outside}" must be repo-relative, with / and no ..`);
    if (!isStringArray(e.imports)) throw new Error(`${where}.entries[${n}].imports must be an array of module ids`);
  }
  for (const e of map.entries) {
    for (const id of e.imports) if (!ids.has(id)) throw new Error(`${where}: module "${e.id}" imports unknown module "${id}"`);
  }
  const allowCycles = map.allowCycles ?? [];
  if (!Array.isArray(allowCycles) || !allowCycles.every((c) => isStringArray(c) && c.length > 0)) {
    throw new Error(`${where}.allowCycles must be an array of file arrays`);
  }
  const prefixes = map.entries.flatMap((e) => e.paths.map((prefix) => ({ prefix, entry: e })));
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  return { prefixes, allowed: new Set(allowCycles.map(cycleKey)) };
}

const cycleKey = (files) => [...new Set(files)].sort().join("\n");

// Enumerating every elementary cycle is exponential in the worst case, and source files are written by ordinary
// lanes, so the walk is bounded: past either limit checkModules throws rather than hang verify.
export const MAX_CYCLES = 1000;
export const MAX_STEPS = 1_000_000;

/**
 * Each node's strongly connected component id (Tarjan): a cycle never leaves its component. Iterative, like
 * findCycles, so a long import chain cannot overflow the call stack.
 */
function components(graph) {
  const index = new Map();
  const low = new Map();
  const comp = new Map();
  const stack = [];
  const work = [];
  const enter = (v) => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    work.push([v, graph.get(v)[Symbol.iterator]()]);
  };
  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    enter(root);
    while (work.length) {
      const [v, edges] = work[work.length - 1];
      const { value: w, done } = edges.next();
      if (!done) {
        if (!index.has(w)) enter(w);
        else if (!comp.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        continue;
      }
      work.pop();
      if (low.get(v) === index.get(v)) {
        let w2;
        do { w2 = stack.pop(); comp.set(w2, v); } while (w2 !== v);
      }
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u), low.get(v)));
      }
    }
  }
  return comp;
}

/** Every elementary cycle, each starting at its smallest file and following import order. */
function findCycles(graph) {
  const nodes = [...graph.keys()].sort();
  const rank = new Map(nodes.map((n, k) => [n, k]));
  const comp = components(graph);
  const cycles = [];
  let steps = 0;
  for (const start of nodes) {
    const path = [start];
    const onPath = new Set(path);
    const edges = [graph.get(start)[Symbol.iterator]()];
    while (edges.length) {
      const { value: next, done } = edges[edges.length - 1].next();
      if (done) {
        edges.pop();
        onPath.delete(path.pop());
        continue;
      }
      if (++steps > MAX_STEPS) throw new Error(`import graph too tangled to list its cycles (over ${MAX_STEPS} steps)`);
      if (next === start) {
        cycles.push([...path]);
        if (cycles.length > MAX_CYCLES) throw new Error(`more than ${MAX_CYCLES} import cycles`);
      } else if (rank.get(next) > rank.get(start) && comp.get(next) === comp.get(start) && !onPath.has(next)) {
        path.push(next);
        onPath.add(next);
        edges.push(graph.get(next)[Symbol.iterator]());
      }
    }
  }
  return cycles.sort((a, b) => (a.join("\n") < b.join("\n") ? -1 : 1));
}

/**
 * `map` is the `modules` value of lanes.config.json; `files` maps repo-relative POSIX paths to their source. Only
 * files in `files` are graph nodes; an import's target is judged by its path, whether or not it is in `files`.
 * Returns `{ violations: [{ from, to, fromModule, toModule }], cycles, allowedCycles, unmapped }`; `toModule` is null
 * for a target no module claims. Does no I/O; throws on a malformed map.
 */
export function checkModules({ map, files }) {
  const { prefixes, allowed } = compileMap(map);
  const moduleOf = (file) => prefixes.find((p) => file.startsWith(p.prefix))?.entry ?? null;
  const names = Object.keys(files).sort();
  const graph = new Map(names.map((f) => [f, new Set()]));
  const violations = [];
  const unmapped = [];
  for (const from of names) {
    const fromEntry = moduleOf(from);
    if (!fromEntry) unmapped.push(from);
    const targets = new Set(importSpecifiers(files[from]).map((spec) => posix.normalize(posix.join(posix.dirname(from), spec))));
    for (const to of [...targets].sort()) {
      if (graph.has(to)) graph.get(from).add(to);
      if (!fromEntry) continue;
      const toEntry = moduleOf(to);
      if (toEntry === fromEntry || (toEntry && fromEntry.imports.includes(toEntry.id))) continue;
      violations.push({ from, to, fromModule: fromEntry.id, toModule: toEntry?.id ?? null });
    }
  }
  const cycles = [];
  const allowedCycles = [];
  for (const cycle of findCycles(graph)) (allowed.has(cycleKey(cycle)) ? allowedCycles : cycles).push(cycle);
  return { violations, cycles, allowedCycles, unmapped };
}

const readConfig = () => JSON.parse(readFileSync("lanes.config.json", "utf8"));

/**
 * Every regular file under `dir` (repo-relative, POSIX; "" is the repo root), or [] when it does not exist. Walks by
 * hand rather than with `recursive: true`, which follows symlinks and junctions out of the repo: a symlinked file or
 * directory is skipped, as are node_modules and .git.
 */
export function listFiles(dir) {
  const files = [];
  const pending = [dir.replace(/\/+$/, "")];
  while (pending.length) {
    const d = pending.pop();
    let entries;
    try {
      entries = readdirSync(d || ".", { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") continue;
      throw err;
    }
    for (const e of entries) {
      const path = d ? `${d}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") pending.push(path); }
      else if (e.isFile()) files.push(path);
    }
  }
  return files;
}

const readFile = (file) => readFileSync(file, "utf8");

const ring = (cycle) => [...cycle, cycle[0]].join(" -> ");

/**
 * Scans every source file in the directories holding the map's path prefixes, so a new file there that no prefix
 * claims shows as unmapped. Returns `{ code, message }`: 0 clean or no map, 1 on any violation, unallowed cycle or
 * unmapped file, 2 when the config cannot be read or the map is malformed. Tests pass fake I/O.
 */
export function main(io = { readConfig, listFiles, readFile }) {
  let config;
  try {
    config = io.readConfig();
  } catch (err) {
    return { code: 2, message: `modules: cannot read lanes.config.json: ${err.message}` };
  }
  const map = config?.modules;
  if (map === undefined) return { code: 0, message: "no module map configured" };
  try {
    const dirs = new Set((Array.isArray(map?.entries) ? map.entries : []).flatMap((e) =>
      (Array.isArray(e?.paths) ? e.paths : []).map((p) => String(p).slice(0, String(p).lastIndexOf("/") + 1))));
    const scanned = [...dirs].flatMap((dir) => io.listFiles(dir)).filter((f) => SOURCE.test(f) && !SKIP_DIRS.test(f));
    const files = Object.fromEntries([...new Set(scanned)].map((f) => [f, io.readFile(f)]));
    const r = checkModules({ map, files });
    const lines = [
      ...r.violations.map((v) => `violation: ${v.from} -> ${v.to} (${v.fromModule} may not import ${v.toModule ?? "an unmapped path"})`),
      ...r.cycles.map((c) => `cycle: ${ring(c)}`),
      ...r.allowedCycles.map((c) => `allowed cycle: ${ring(c)}`),
      ...r.unmapped.map((f) => `unmapped: ${f}`),
      `modules: ${Object.keys(files).length} files, ${r.violations.length} violations, ${r.cycles.length} cycles` +
        ` (${r.allowedCycles.length} allowed), ${r.unmapped.length} unmapped`,
    ];
    const failed = r.violations.length || r.cycles.length || r.unmapped.length;
    return { code: failed ? 1 : 0, message: lines.join("\n") };
  } catch (err) {
    return { code: 2, message: `modules: ${err.message}` };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main();
  console.log(message);
  process.exitCode = code;
}
