// scripts/lanes/init.mjs
// #714: the guided first run. Runs only the first-run steps `setup-state` reports missing, in order, never repeats a
// finished step, never creates a second App, and ends with a checklist of what is left, each item with its link.
// Usage: node scripts/lanes/init.mjs <path-to-repo>
//        node scripts/lanes/init.mjs --new <name> [--private] [--license mit] [--org <org>] [--dry-run]
// Exit 0: every item is done. 1: something is left or a step failed. 2: bad usage.
// Run from the lanes clone. The setup scripts (install, new-project, setup-repo, app-setup) are run, not changed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { formatSetupState, setupState } from "./setup-state.mjs";

const USAGE = "usage: init.mjs <path> | init.mjs --new <name> [--private] [--license mit] [--org <org>] [--dry-run]";
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET = "PII_PATTERNS";

/** @param {string[]} argv the arguments after the script path; throws a usage message when malformed */
export function parseArgs(argv) {
  const out = { path: undefined, name: undefined, isPrivate: false, license: undefined, org: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--private") out.isPrivate = true;
    else if (a === "--new") out.name = argv[++i];
    else if (a === "--license") {
      const v = argv[++i];
      if (v !== "mit") throw new Error(`unsupported license "${v ?? ""}": only mit is available`);
      out.license = v;
    } else if (a === "--org") {
      const v = argv[++i];
      if (!OWNER_RE.test(v ?? "")) throw new Error(`invalid --org "${v ?? ""}"`);
      out.org = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (out.path === undefined) out.path = a;
    else throw new Error(USAGE);
  }
  const isNew = argv.includes("--new");
  if (isNew === (out.path !== undefined)) throw new Error(USAGE);
  if (isNew) {
    if (!NAME_RE.test(out.name ?? "") || out.name === "." || out.name === "..") throw new Error(`invalid repository name "${out.name ?? ""}"`);
  } else if (out.isPrivate || out.license || out.org) throw new Error(`--private, --license and --org go with --new\n${USAGE}`);
  return out;
}

/** What a dry run prints: every step in order, none run. */
export function dryRunPlan({ isNew, name, flags = [] }) {
  return [
    isNew ? `1. node scripts/lanes/new-project.mjs ${[name, ...flags].join(" ")} (only when the project is not installed yet)` : "1. node scripts/lanes/install.mjs <path> (only when lanes.lock.json is missing)",
    `2. the ${SECRET} secret: print gh secret set ${SECRET}, wait for "done", re-check (only when missing)`,
    "3. node scripts/lanes/setup-repo.mjs <owner/repo> (only when labels or the main ruleset are missing)",
    "4. node scripts/lanes/app-setup.mjs, run in the target (only when identity is missing; never when the App exists)",
    "5. CODEOWNERS and the code-owner ruleset: print the GitHub settings links (only when missing)",
    "6. node scripts/lanes/app-setup.mjs --workflows (only when workflows-environment is missing)",
    "7. a final setup-state checklist",
  ];
}

const byName = (items) => Object.fromEntries(items.map((i) => [i.name, i]));
const fixLines = (i) => [i.fix?.link && `  open ${i.fix.link}`, i.fix?.command && `  run: ${i.fix.command}`].filter(Boolean);

/**
 * @param {string[]} argv
 * @param {{ lanesRoot?: string, run?: Function, state?: Function, repoOf?: Function, ownerOf?: Function, ask?: Function,
 *   exists?: Function, print?: Function }} deps every outside effect is injected, so tests touch no network or disk
 * @returns {Promise<number>} the exit code
 */
export async function initMain(argv, deps = {}) {
  const { lanesRoot = defaults.lanesRoot, run = defaults.run, state = defaults.state, repoOf = defaults.repoOf, ownerOf = defaults.ownerOf, ask = defaults.ask, exists = existsSync, print = console.log } = deps;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    print(e.message);
    return 2;
  }
  const isNew = opts.path === undefined;
  if (opts.dryRun) {
    const flags = [opts.isPrivate && "--private", opts.license && `--license ${opts.license}`].filter(Boolean);
    print(["Dry run: these are the steps init would run, each only when its item is missing. Nothing was run.", ...dryRunPlan({ isNew, name: opts.name, flags })].join("\n"));
    return 0;
  }

  let target;
  let repo;
  if (isNew) {
    const owner = ownerOf(lanesRoot);
    if (opts.org && owner && opts.org !== owner) {
      print(`new-project.mjs creates the repository under ${owner}, the owner of this lanes clone, not ${opts.org}.`);
      return 2;
    }
    if (!owner || !OWNER_RE.test(owner)) {
      print("the repository owner could not be read: run gh auth login");
      return 1;
    }
    target = path.resolve(lanesRoot, "..", opts.name);
    repo = `${opts.org ?? owner}/${opts.name}`;
  } else {
    target = path.resolve(opts.path);
    repo = repoOf(target);
    if (!REPO_RE.test(repo ?? "")) {
      print("the repository could not be read: run gh auth login and check the path is a GitHub repository");
      return 1;
    }
  }

  const read = () => byName(state(target, repo));
  const fail = (step, r) => {
    print(`init stopped: ${step} failed${r?.status != null ? ` (exit ${r.status})` : ""}.${r?.output ? `\n${r.output}` : ""}\nLater steps did not run. Fix the cause and run init again; finished steps are skipped.`);
    return 1;
  };
  const exec = (step, cmd, args, cwd) => {
    print(`init: ${step}`);
    try {
      const r = run(cmd, args, { cwd });
      return r && r.status === 0 ? undefined : fail(step, r);
    } catch (e) {
      return fail(step, { output: String(e?.message ?? e) });
    }
  };

  let items = isNew && !exists(path.join(target, "lanes.lock.json")) ? undefined : read();

  // 1. install, or new-project
  if (isNew ? !items : !items.installed.done) {
    const flags = [opts.isPrivate && "--private", opts.license && "--license", opts.license].filter(Boolean);
    const code = isNew
      ? exec("new-project.mjs", "node", [path.join("scripts", "lanes", "new-project.mjs"), opts.name, ...flags], lanesRoot)
      : exec("install.mjs", "node", [path.join("scripts", "lanes", "install.mjs"), target], lanesRoot);
    if (code !== undefined) return code;
    items = read();
  }

  // 2. the PII_PATTERNS secret
  if (!items.secret.done) {
    print(`\nSet the ${SECRET} secret in another terminal (init never sees the value):\n\n  gh secret set ${SECRET} -R ${repo}\n`);
    if ((await ask(`Type "done" once the secret is set (anything else stops here): `)).trim() !== "done") {
      print(`init stopped: the ${SECRET} secret was not confirmed. Run init again when it is set.`);
      return 1;
    }
    items = read();
    if (!items.secret.done) {
      print(`init stopped: ${repo} still has no ${SECRET} secret. Set it, then run init again.`);
      return 1;
    }
  }

  // 3. setup-repo
  if (!items.labels.done || !items["main-ruleset"].done) {
    const code = exec("setup-repo.mjs", "node", [path.join("scripts", "lanes", "setup-repo.mjs"), repo], target);
    if (code !== undefined) return code;
    items = read();
  }

  // 4. the App: created once, only when identity is missing
  if (items.identity.done) {
    const broken = [items["app-key"], items["app-installed"]].filter((i) => !i.done);
    if (broken.length) {
      print(["init stopped: the App already exists in lanes.config.json, so init will not create a second one.", ...broken.flatMap((i) => [`${i.name}: ${i.reason}`, ...fixLines(i)]), "Fix it, then run init again."].join("\n"));
      return 1;
    }
  } else {
    const code = exec("app-setup.mjs", "node", [path.join("scripts", "lanes", "app-setup.mjs")], target);
    if (code !== undefined) return code;
    items = read();
    if (!items.identity.done) {
      print("init stopped: app-setup.mjs finished but identity.app is still missing from lanes.config.json. Run init again.");
      return 1;
    }
  }

  // 5. CODEOWNERS and the code-owner ruleset are GitHub settings the owner clicks
  const clicks = [items.codeowners, items["code-owner-ruleset"]].filter((i) => !i.done);
  if (clicks.length) print(["\nYour turn on GitHub (init cannot click these):", ...clicks.flatMap((i) => [`${i.name}: ${i.reason}`, ...fixLines(i)])].join("\n"));

  // 6. the workflow-apply environment
  if (!items["workflows-environment"].done) {
    const code = exec("app-setup.mjs --workflows", "node", [path.join("scripts", "lanes", "app-setup.mjs"), "--workflows"], target);
    if (code !== undefined) return code;
  }

  // 7. the final checklist
  items = state(target, repo);
  const left = items.filter((i) => !i.done);
  if (!left.length) {
    print(`\n${formatSetupState(items)}\n\nAll done: every first-run item is in place.`);
    return 0;
  }
  print(`\nWhat is left (${left.length}):\n${formatSetupState(left)}\n\nWhen you have done these, run init again; finished steps are skipped.`);
  return 1;
}

const gitRun = (cmd, args, { cwd } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};
const ghView = (cwd, jq) => {
  try {
    const r = gitRun("gh", ["repo", "view", "--json", jq.json, "--jq", jq.expr], { cwd });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
};

const defaults = {
  lanesRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  // Steps are interactive (app-setup prints a link, new-project asks), so they inherit the terminal.
  run: (cmd, args, { cwd } = {}) => {
    const r = spawnSync(cmd, args, { cwd, stdio: "inherit", windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status };
  },
  state: (target, repo) => setupState({ run: gitRun, exists: existsSync, home: homedir(), target, repo }),
  repoOf: (target) => ghView(target, { json: "nameWithOwner", expr: ".nameWithOwner" }),
  ownerOf: (cwd) => ghView(cwd, { json: "owner", expr: ".owner.login" }),
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await initMain(process.argv.slice(2));
