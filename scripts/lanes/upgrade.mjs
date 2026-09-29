// Upgrades a project that installed lanes (ADR 0016): node scripts/lanes/upgrade.mjs <target-dir> [--apply]
// Without --apply it prints one line per file and writes nothing. With --apply it performs that plan, adds the missing
// top-level keys of lanes.config.json and rewrites lanes.lock.json. A file the adopter edited is never overwritten.
// Exit 0: done. 2: run inside Claude (CLAUDECODE), no target, no or invalid lanes.lock.json, or a path outside the target.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "./install.mjs";

const LOCK = "lanes.lock.json";
const CONFIG = "lanes.config.json";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(path.join(HERE, "..", "..", "contracts", "lanes-lock.schema.json"), "utf8"));
const SEMVER = new RegExp(schema.$defs.semver.pattern);
const SHA256 = new RegExp(schema.$defs.sha256.pattern);
const REPO_PATH = new RegExp(schema.$defs.repoPath.pattern);

class Refusal extends Error {}

const hashOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The lock, checked against contracts/lanes-lock.schema.json. @throws {Refusal} when it is missing or invalid. */
export function readLock(target) {
  const file = path.join(target, LOCK);
  if (!existsSync(file)) throw new Refusal(`${LOCK} not found in the target: run install.mjs first`);
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Refusal(`${LOCK} is not valid JSON`);
  }
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!plain(lock) || !plain(lock.files)) throw new Refusal(`${LOCK} does not validate: expected { version, files }`);
  if (Object.keys(lock).some((k) => k !== "version" && k !== "files")) throw new Refusal(`${LOCK} does not validate: unknown key`);
  if (typeof lock.version !== "string" || !SEMVER.test(lock.version)) throw new Refusal(`${LOCK} does not validate: version is not semver`);
  for (const [p, h] of Object.entries(lock.files)) {
    if (!REPO_PATH.test(p)) throw new Refusal(`${LOCK} does not validate: path outside the repository: ${p}`);
    if (typeof h !== "string" || !SHA256.test(h)) throw new Refusal(`${LOCK} does not validate: bad sha256 for ${p}`);
  }
  return lock;
}

/** Throws unless `rel` resolves inside `target`, following symlinks in the nearest existing ancestor (and in the file itself). */
function safePath(target, rel) {
  const root = realpathSync(target);
  const full = path.resolve(target, rel);
  let probe = full;
  while (!existsSync(probe) && !isLink(probe)) probe = path.dirname(probe);
  const real = realpathSync(probe);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (!inside(real) || (isLink(full) && !inside(realpathSync.native(full)))) throw new Refusal(`refusing a path outside the target: ${rel}`);
  return full;
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The plan, one entry per file: `file` is the path in the target (the dashboard workflow keeps its `.disabled` name when the
 * lock has it), `from` the path in the source, `action` overwrite | refuse | add | "no longer part of lanes".
 */
export function planUpgrade(source, target, manifest = MANIFEST) {
  const lock = readLock(target);
  const plan = [];
  const seen = new Set();
  for (const from of manifest.filter((f) => f !== CONFIG)) {
    const file = `${from}.disabled` in lock.files && !(from in lock.files) ? `${from}.disabled` : from;
    seen.add(file);
    const dest = safePath(target, file);
    const present = existsSync(dest);
    let action;
    if (file in lock.files) action = present && hashOf(dest) === lock.files[file] ? "overwrite" : "refuse";
    else action = present ? "refuse" : "add";
    plan.push({ file, from, action });
  }
  for (const file of Object.keys(lock.files).sort()) {
    safePath(target, file);
    if (!seen.has(file)) plan.push({ file, from: file, action: "no longer part of lanes" });
  }
  return plan;
}

/** The top-level keys of the source's lanes.config.json that the target's lacks; nothing when either is unreadable. */
function missingConfigKeys(source, target) {
  const read = (dir) => {
    try {
      const v = JSON.parse(readFileSync(path.join(dir, CONFIG), "utf8"));
      return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const [src, mine] = [read(source), read(target)];
  if (!src || !mine) return { mine, added: {} };
  return { mine, added: Object.fromEntries(Object.entries(src).filter(([k]) => !(k in mine))) };
}

/**
 * Performs the plan: writes the overwrite and add files, merges the missing config keys, rewrites the lock.
 * @returns {string[]} the config keys added
 */
export function applyUpgrade(source, target, plan) {
  const lock = readLock(target);
  const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const files = {};
  for (const { file, from, action } of plan) {
    const dest = safePath(target, file);
    if (action === "overwrite" || action === "add") {
      mkdirSync(path.dirname(dest), { recursive: true });
      safePath(target, file); // the directories now exist: check again before writing
      copyFileSync(path.join(source, from), dest);
      files[file] = hashOf(dest);
    } else if (action === "refuse" && file in lock.files) files[file] = lock.files[file];
  }
  const { mine, added } = missingConfigKeys(source, target);
  const keys = Object.keys(added);
  if (keys.length) writeFileSync(safePath(target, CONFIG), `${JSON.stringify({ ...mine, ...added }, null, 2)}\n`);
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(safePath(target, LOCK), `${JSON.stringify({ version, files: sorted }, null, 2)}\n`);
  return keys;
}

export function main(argv, env = process.env, { source = ".", manifest = MANIFEST, print = console.log } = {}) {
  if (env.CLAUDECODE) {
    print("upgrade.mjs refuses to run inside Claude (CLAUDECODE is set): run it in your own terminal");
    return 2;
  }
  const flags = argv.filter((a) => a.startsWith("--"));
  const [target, ...rest] = argv.filter((a) => !a.startsWith("--"));
  if (!target || rest.length || flags.some((f) => f !== "--apply") || !existsSync(target) || !statSync(target).isDirectory()) {
    print("usage: upgrade.mjs <target-dir> [--apply]: the target must be an existing directory");
    return 2;
  }
  try {
    const plan = planUpgrade(source, target, manifest);
    for (const { file, action } of plan) print(`${action} ${file}`);
    if (!flags.includes("--apply")) {
      print("Nothing written. Run again with --apply to perform this plan.");
      return 0;
    }
    for (const key of applyUpgrade(source, target, plan)) print(`config ${key}`);
    print(`Upgraded: ${LOCK} rewritten.`);
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    print(e.message);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
