// scripts/lanes/new-project.mjs
// OWNER ONLY. One command from nothing to a lanes project:
//   node scripts/lanes/new-project.mjs <name> [--private] [--license mit] [--dry-run]
// Creates <org>/<name> (the org that owns this lanes clone), clones it next to lanes, installs the template, writes a
// starter lanes.config.json, verify.yml, package.json and LICENSE, runs `npm run setup`, commits once and pushes main
// before any ruleset exists. Then it pauses for the owner's PII_PATTERNS secret and, once confirmed and present, runs
// setup-repo.mjs. --dry-run prints every step and changes nothing (it still reads the org and this repo's files).
// The planning part (planProject) is pure; runPlan executes a plan through injected effects.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { install, starterConfig } from "./install.mjs";

export const SECRET_NAME = "PII_PATTERNS";
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const USAGE = "usage: new-project.mjs <name> [--private] [--license mit] [--dry-run]";

/** @param {string[]} argv the arguments after the script path */
export function parseArgs(argv) {
  const out = { name: undefined, isPrivate: false, license: "mit", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--private") out.isPrivate = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--license") {
      const v = argv[++i];
      if (v !== "mit") throw new Error(`unsupported license "${v ?? ""}": only mit is available`);
      out.license = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (out.name === undefined) out.name = a;
    else throw new Error(USAGE);
  }
  if (out.name === undefined) throw new Error(USAGE);
  if (!NAME_RE.test(out.name) || out.name === "." || out.name === "..") throw new Error(`invalid repository name "${out.name}"`);
  return out;
}

/**
 * Why a private repo cannot carry the lanes ruleset in this org, or [] when it can. Fails closed: an unknown field
 * (the plan is only visible to org owners) counts as missing.
 * @param {object|null} org the `gh api orgs/<org>` response, or null when the owner is not an organisation
 */
export function privateBlockers(org) {
  if (!org || org.type !== "Organization") return ["the owner is not an organisation (the merge queue needs one)"];
  const out = [];
  if (org.plan?.name !== "enterprise") out.push("a private repo's merge queue needs GitHub Enterprise Cloud (org plan is not visible as enterprise)");
  if (org.advanced_security_enabled_for_new_repositories !== true) out.push("CodeQL default setup on a private repo needs GitHub Advanced Security enabled for new repositories");
  return out;
}

/** The copyright holder from a LICENSE's "Copyright (c) <year> <holder>" line. Never echoes the file on failure. */
export function licenseHolder(text) {
  const m = /^Copyright \(c\) \d{4}(?:\s*-\s*\d{4})?\s+(.+?)\s*$/m.exec(text);
  if (!m) throw new Error("lanes LICENSE has no \"Copyright (c) <year> <holder>\" line");
  return m[1];
}

export function mitLicense(year, holder) {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

export function starterPackageJson(name) {
  return {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    license: "MIT",
    engines: { node: ">=22" },
    scripts: {
      test: "node --test",
      setup: "git config core.hooksPath .githooks",
      preflight: "node scripts/preflight.mjs",
      status: "node scripts/lanes/status.mjs",
      "delivery-metrics": "node scripts/lanes/delivery-metrics.mjs",
    },
  };
}

/** verify.yml must run on pull_request, merge_group and push to main, in a job named `verify` (the required check). */
export function hasVerifyTriggers(yml) {
  return /^\s*pull_request:/m.test(yml) && /^\s*merge_group:/m.test(yml) && /^\s*push:\s*\n\s*branches:\s*\[\s*main\s*\]/m.test(yml) && /^ {2}verify:/m.test(yml);
}

/**
 * Every step, in order, as data. `say` is what a dry run prints; it never contains file content.
 * @param {{ name: string, org: string, isPrivate: boolean, lanesRoot: string, year: number,
 *   files: { verifyYml: string, lanesConfig: object, lanesLicense: string } }} p
 */
export function planProject({ name, org, isPrivate, lanesRoot, files, year }) {
  if (!hasVerifyTriggers(files.verifyYml)) throw new Error("lanes verify.yml lacks pull_request, merge_group, push to main or a `verify` job");
  const repo = `${org}/${name}`;
  const target = path.resolve(lanesRoot, "..", name);
  const run = (cmd, args, cwd, say) => ({ kind: "run", cmd, args, cwd, say: say ?? `${cmd} ${args.join(" ")}` });
  const write = (file, content, say) => ({ kind: "write", file, target, content, say: say ?? `write ${file}` });
  return [
    run("gh", ["repo", "create", repo, isPrivate ? "--private" : "--public"], lanesRoot),
    run("gh", ["repo", "clone", repo, target], lanesRoot, `gh repo clone ${repo} ../${name}`),
    run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], target),
    { kind: "install", source: lanesRoot, target, say: `install the lanes template into ../${name} (install.mjs)` },
    write("lanes.config.json", `${JSON.stringify(starterConfig(files.lanesConfig), null, 2)}\n`, "write lanes.config.json (starter)"),
    write(".github/workflows/verify.yml", files.verifyYml, "write .github/workflows/verify.yml (pull_request, merge_group, push to main)"),
    write("package.json", `${JSON.stringify(starterPackageJson(name), null, 2)}\n`, "write package.json (test, setup, preflight, status, delivery-metrics)"),
    write("LICENSE", mitLicense(year, licenseHolder(files.lanesLicense)), `write LICENSE (MIT, ${year}, holder from the lanes LICENSE)`),
    run("npm", ["run", "setup"], target),
    run("git", ["add", "-A"], target),
    run("git", ["update-index", "--chmod=+x", ".githooks/pre-push"], target),
    run("git", ["commit", "-m", "chore: set up lanes"], target),
    run("git", ["push", "-u", "origin", "main"], target),
    { kind: "confirm", command: `gh secret set ${SECRET_NAME} -R ${repo}`, say: `pause: the owner sets the ${SECRET_NAME} secret` },
    { kind: "check-secret", repo, secret: SECRET_NAME, say: `check that ${repo} has the ${SECRET_NAME} secret` },
    run("node", [path.join("scripts", "lanes", "setup-repo.mjs"), repo], target, `node scripts/lanes/setup-repo.mjs ${repo} (in ../${name})`),
  ];
}

/**
 * Executes a plan, or with dryRun only prints it. Stops (completed: false) when the owner does not confirm or the
 * secret is still missing, so setup-repo never runs without it.
 */
export async function runPlan(steps, { dryRun, effects }) {
  for (const [i, step] of steps.entries()) {
    const n = `${i + 1}/${steps.length}`;
    if (dryRun) {
      effects.log(`[dry run] ${n} ${step.say}${step.kind === "confirm" ? `\n            the owner runs: ${step.command}` : ""}`);
      continue;
    }
    effects.log(`${n} ${step.say}`);
    if (step.kind === "run") effects.run(step);
    else if (step.kind === "install") effects.install(step);
    else if (step.kind === "write") effects.write(step);
    else if (step.kind === "confirm") {
      effects.log(
        `\nSet the secret now, in another terminal (one fixed string per line; this script never sees the value):\n\n  ${step.command}\n\n` +
          `Its prompt takes one line; for several patterns, feed it a file instead: ${step.command} < <file>\n`,
      );
      if (!(await effects.confirm())) return { completed: false, stoppedAt: i };
    } else if (step.kind === "check-secret") {
      if (!effects.hasSecret(step.repo, step.secret)) {
        effects.log(`${step.repo} has no ${step.secret} secret; stopping before setup-repo.mjs.`);
        return { completed: false, stoppedAt: i };
      }
    } else throw new Error(`unknown step kind ${step.kind}`);
  }
  return { completed: true };
}

/** An argument safe to pass through a shell unquoted, or a throw. */
export function shellWord(arg) {
  if (!/^[A-Za-z0-9_.:=-]+$/.test(arg)) throw new Error(`refusing to pass "${arg}" through a shell`);
  return arg;
}

const gh = (args, cwd) => execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const realEffects = {
  run: (s) =>
    // npm is a .cmd shim on Windows, which execFile cannot start without a shell. Only plain words may reach that
    // shell, so a future step with dynamic arguments fails loudly instead of becoming an injection.
    s.cmd === "npm" && process.platform === "win32"
      ? execFileSync(`npm ${s.args.map(shellWord).join(" ")}`, { cwd: s.cwd, stdio: "inherit", shell: true, windowsHide: true })
      : execFileSync(s.cmd, s.args, { cwd: s.cwd, stdio: "inherit", windowsHide: true }),
  install: (s) => install(s.source, s.target, { force: true }),
  write: (s) => {
    const to = path.join(s.target, s.file);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, s.content);
  },
  confirm: async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(`Type "done" once the secret is set (anything else stops here): `)).trim() === "done";
    } finally {
      rl.close();
    }
  },
  hasSecret: (repo, name) => JSON.parse(gh(["secret", "list", "-R", repo, "--json", "name"])).some((s) => s.name === name),
  log: (line) => console.log(line),
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lanesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const org = gh(["repo", "view", "--json", "owner", "-q", ".owner.login"], lanesRoot).trim();
  const target = path.resolve(lanesRoot, "..", opts.name);
  if (existsSync(target)) throw new Error(`../${opts.name} already exists next to lanes`);
  if (opts.isPrivate) {
    let info = null;
    try {
      info = JSON.parse(gh(["api", `orgs/${org}`]));
    } catch {
      info = null; // a user account, or no access: privateBlockers refuses
    }
    const blockers = privateBlockers(info);
    if (blockers.length) throw new Error(`refusing --private for ${org}:\n- ${blockers.join("\n- ")}`);
  }
  const read = (rel) => readFileSync(path.join(lanesRoot, rel), "utf8");
  const steps = planProject({
    name: opts.name,
    org,
    isPrivate: opts.isPrivate,
    lanesRoot,
    year: new Date().getFullYear(),
    files: { verifyYml: read(".github/workflows/verify.yml"), lanesConfig: JSON.parse(read("lanes.config.json")), lanesLicense: read("LICENSE") },
  });
  const r = await runPlan(steps, { dryRun: opts.dryRun, effects: realEffects });
  if (opts.dryRun) console.log("\nDry run: nothing was changed.");
  else if (r.completed) console.log(`\n${org}/${opts.name} is ready for lanes. Edit its lanes.config.json paths for its layout.`);
  else {
    console.log(`\nStopped before setup-repo.mjs. When the secret is set, run it from ../${opts.name}:`);
    console.log(`  node scripts/lanes/setup-repo.mjs ${org}/${opts.name}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`new-project: ${e.message}`);
    process.exitCode = 1;
  });
}
