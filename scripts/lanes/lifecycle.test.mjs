// A lane's life end to end (#233): start.mjs launches it, reap.mjs waits and removes it, cleanup.mjs sweeps what is left.
// The real entry points run against a real temporary git repository with a bare `origin`; only `claude` and `gh` are
// faked, in-process, from one shared state, and every `git` call goes to real git. No network and no binary but git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupMerged, loadCleanupInputs, shOptions } from "./cleanup.mjs";
import { FIRST_POLL_MS, POLL_MS, STARTUP_GRACE_MS, main as reap, runOptions } from "./reap.mjs";
import { main as start } from "./start.mjs";

const ISSUE = 233;
const SLUG = "issue-233-lifecycle";
const form = (n) =>
  ["### Goal", `g${n}`, "### Acceptance criteria", "- [ ] a", "### Interface contract", "none", "### Scope", `In: \`scripts/x${n}.mjs\`.`, "### Blocked by", "None", "### Tier", "full"].join("\n\n");

// A git hook (pre-commit, pre-push) runs with GIT_DIR and friends set, which would send these git calls to the real repo.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const gitOptions = (cwd) => ({ cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const git = (cwd, ...args) => execFileSync("git", args, gitOptions(cwd)).trim();

// A repository with a bare origin and one pushed commit on main. `w.calls` records every fake `run`.
function world() {
  // The native form: on Windows the temp dir can be an 8.3 short path (RUNNER~1) that git never reports.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lanes-lifecycle-")));
  const origin = join(dir, "origin.git");
  const root = join(dir, "repo");
  mkdirSync(root);
  git(dir, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "lane@example.invalid");
  git(root, "config", "user.name", "lane");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-u", "origin", "main");

  const w = {
    dir,
    root,
    calls: [],
    sessions: new Map(), // id → { id, kind, cwd, status, state }
    hidden: new Set(), // session ids `claude agents` does not list yet
    issues: new Map([[ISSUE, "OPEN"]]),
    prs: [], // { number, state, headRefName, branch? } (headRefOid is read from git)
    nextId: 1,
  };
  w.cleanup = () => rmSync(dir, { recursive: true, force: true });
  w.worktree = (n, slug = `issue-${n}-lifecycle`) => {
    const path = join(root, ".claude", "worktrees", `issue-${n}`);
    git(root, "worktree", "add", path, "-b", slug, "origin/main");
    return { path, branch: slug };
  };
  const list = () => [...w.sessions.values()].filter((s) => !w.hidden.has(s.id));
  const claude = (args) => {
    if (args[0] === "--bg") {
      const id = `sess${w.nextId++}`;
      w.sessions.set(id, { id, kind: "background", cwd: root, status: "busy", state: "working" });
      return `backgrounded · ${id}\n`;
    }
    const id = args[1];
    if (args[0] === "agents") return JSON.stringify(list());
    if (["logs", "stop", "rm"].includes(args[0]) && !w.sessions.has(id)) throw Object.assign(new Error("job not found"), { stderr: `job not found: ${id}` });
    if (args[0] === "logs") return `log of ${id}\n`;
    if (args[0] === "stop") w.sessions.get(id).status = "idle";
    else if (args[0] === "rm") w.sessions.delete(id);
    else throw new Error(`unexpected claude call: ${args.join(" ")}`);
    return "";
  };
  const gh = (args) => {
    // A PR remembers its head commit from when it is first listed, as on GitHub, after the branch is deleted.
    const prs = () => w.prs.map((p) => ({ number: p.number, state: p.state, headRefName: p.headRefName, headRefOid: (p.oid ??= git(root, "rev-parse", p.headRefName)) }));
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      const state = w.issues.get(n);
      if (!state) throw new Error("gh: Could not resolve to an issue");
      if (args.includes("--jq")) return `${state}\n`;
      return JSON.stringify({ number: n, state, labels: ["ready", "tier:full"].map((name) => ({ name })), body: form(n) });
    }
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([...w.issues].map(([number, state]) => ({ number, state, labels: [], body: form(number) })));
    if (args[0] === "api") return JSON.stringify({ state: "closed" });
    if (args[0] === "pr" && args[1] === "list") {
      const want = args[args.indexOf("--state") + 1];
      return JSON.stringify(prs().filter((p) => want === "all" || p.state.toLowerCase() === want));
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  // The one fake `run`: records the call with its options, answers claude and gh, and passes git to real git.
  w.run = (cmd, args, options = {}, by = "test") => {
    w.calls.push({ by, cmd, args, options });
    if (cmd === "claude") return claude(args);
    if (cmd === "gh") return gh(args);
    if (cmd === "git") return execFileSync("git", args, gitOptions(root));
    throw new Error(`unexpected command: ${cmd}`);
  };
  w.count = (cmd, ...args) => w.calls.filter((c) => c.cmd === cmd && args.every((a, i) => c.args[i] === a)).length;

  // cleanup.mjs's own defaults for these use the process's cwd and real timers, so the test supplies them. The load step
  // is the real loadCleanupInputs over the shared run; `ownLoad: false` leaves it to reap.mjs's own wiring.
  w.cleanupDeps = (by, { ownLoad = true } = {}) => ({
    ...(ownLoad ? { load: () => loadCleanupInputs(root, (cmd, args) => w.run(cmd, args, shOptions(), by)) } : {}),
    run: (cmd, args) => w.run(cmd, args, shOptions(), by),
    stillThere: (onlyIf) => {
      if (onlyIf.path) return existsSync(onlyIf.path);
      try {
        w.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${onlyIf.branch}`], shOptions(), by);
        return true;
      } catch {
        return false;
      }
    },
    sleep: () => {},
  });
  return w;
}

const branchThere = (w, branch) => {
  try {
    git(w.root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

// start.mjs's dependencies over the shared fakes, with the /start grant the guard hook would have written.
function startDeps(w) {
  const grants = join(w.dir, "grants");
  mkdirSync(grants);
  const sessionId = "owner-session";
  writeFileSync(join(grants, `${sessionId}.json`), JSON.stringify({ sessionId, issues: [ISSUE], at: new Date().toISOString() }));
  w.spawned = [];
  return {
    gh: (args) => w.run("gh", args, {}, "start"),
    claude: (args, options) => w.run("claude", args, options, "start"),
    root: () => w.root,
    // ADR 0025: team is the only profile; the team steps are faked and the refresher's spawn is not a reaper's.
    config: () => ({ identity: { profile: "team", app: { id: 11, installationId: 22, botLogin: "sour-dev-lanes[bot]" } } }),
    team: {
      keyFile: () => "/keys/app.pem",
      readable: () => {},
      repo: () => "lanes",
      makeDir: (n) => ({ dir: `/tmp/lane-${n}`, emptyConfig: `/tmp/lane-${n}/empty` }),
      removeDir: () => {},
      writeSettings: () => {},
      mintInto: () => {},
      botUserId: () => "336249257",
    },
    cleanup: ({ dryRun }) => cleanupMerged({ dryRun, deps: w.cleanupDeps("start-cleanup") }),
    spawn: (cmd, args, options) => {
      if (!args.includes("--refresh-token")) w.spawned.push({ cmd, args, options });
      return { pid: 4242, on() {}, unref() {} };
    },
    reaperLog: () => ({ fd: -1, close() {} }),
    session: () => sessionId,
    grantDir: () => grants,
    now: Date.now,
  };
}

// reap.mjs over the shared fakes with a fake clock; `onSleep(i)` moves the world on before poll i (0 is the first poll).
function reaper(w, session, onSleep, { jump } = {}) {
  let t = Date.UTC(2026, 8, 28, 12);
  let i = 0;
  return reap(["--issue", String(ISSUE), "--session", session], {
    root: w.root,
    pid: 4242,
    run: (cmd, args) => w.run(cmd, args, runOptions(w.root), "reap"),
    now: () => t,
    sleep: async (ms) => {
      t += jump ?? ms;
      onSleep?.(i++, ms);
    },
    isRunning: () => false,
    err: () => {},
    trap: () => {},
    cleanupDeps: w.cleanupDeps("reap-cleanup", { ownLoad: false }),
  });
}

const reaperLog = (w) => readFileSync(join(w.root, ".lanes", "reap", `${ISSUE}.log`), "utf8");

test("scenario 1: a lane starts, the reaper waits through the startup, and removes it once, after the merge", async (t) => {
  const w = world();
  t.after(w.cleanup);

  const { code, lines } = start([String(ISSUE)], startDeps(w));
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /#233 → sess1/);
  assert.equal(w.count("claude", "--bg"), 1);
  assert.equal(w.spawned.length, 1);
  const [, script, ...rest] = [w.spawned[0].cmd, ...w.spawned[0].args];
  assert.match(script.replaceAll("\\", "/"), /scripts\/lanes\/reap\.mjs$/);
  assert.deepEqual(rest, ["--issue", "233", "--session", "sess1"]);
  const session = rest.at(-1);

  // Poll 0: not listed. Poll 1: listed at the repository root. Poll 2: in its worktree, PR open. Poll 3: merged.
  w.hidden.add(session);
  const waits = [];
  let lane;
  const exit = await reaper(w, session, (i, ms) => {
    waits.push(ms);
    if (i === 1) w.hidden.delete(session);
    if (i === 2) {
      lane = w.worktree(ISSUE, SLUG);
      w.sessions.get(session).cwd = lane.path;
      w.prs.push({ number: 300, state: "OPEN", headRefName: SLUG });
    }
    if (i === 3) {
      w.prs[0].state = "MERGED";
      w.sessions.get(session).status = "idle";
    }
  });

  assert.equal(exit, 0, reaperLog(w));
  assert.deepEqual(waits, [FIRST_POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
  assert.equal(existsSync(lane.path), false, "worktree removed");
  assert.equal(branchThere(w, SLUG), false, "branch removed");
  assert.equal(w.sessions.has(session), false, "session removed");
  assert.equal(w.count("claude", "rm", session), 1);
  assert.equal(w.count("git", "worktree", "remove"), 1);
  assert.equal(w.count("git", "branch", "-D", SLUG), 1);
  const log = reaperLog(w);
  assert.equal(log.match(/ removed: /g).length, 1);
  assert.match(log, /waiting: session sess1 is not listed yet/);
  // A session at the repository root is kept by sessionsFrom, so the reaper waits for it to enter its worktree.
  assert.match(log, /waiting: session sess1 is not in an issue-233 worktree yet/);
  assert.doesNotMatch(log, /gave up|error/);
  assert.match(log, /waiting: PR #300 is open/);
});

test("scenario 2: a replaced session's old reaper never removes the new worktree", async (t) => {
  const w = world();
  t.after(w.cleanup);
  const lane = w.worktree(ISSUE, SLUG);
  // The old lane (sess1) is gone; the issue was relaunched as sess2, which is working in the worktree. A merged PR
  // and the closed-looking state are what would tempt a reaper that only looks at the issue.
  w.sessions.set("sess2", { id: "sess2", kind: "background", cwd: lane.path, status: "busy", state: "working" });
  w.prs.push({ number: 300, state: "MERGED", headRefName: SLUG });

  const exit = await reaper(w, "sess1", undefined, { jump: STARTUP_GRACE_MS + POLL_MS });

  assert.equal(exit, 1, "the old reaper gives up");
  assert.match(reaperLog(w), /gave up: session sess1 not found/);
  assert.equal(existsSync(lane.path), true);
  assert.equal(branchThere(w, SLUG), true);
  assert.equal(w.sessions.has("sess2"), true);
  assert.equal(w.count("claude", "rm"), 0);
  assert.equal(w.count("claude", "stop"), 0);
  assert.equal(w.count("git", "worktree", "remove"), 0);
  assert.equal(w.count("git", "branch", "-D"), 0);
});

test("scenario 3: cleanup at /start skips a working lane and removes a merged one", (t) => {
  const w = world();
  t.after(w.cleanup);
  const working = w.worktree(301, "issue-301-working");
  const merged = w.worktree(302, "issue-302-merged");
  w.issues.set(301, "OPEN").set(302, "OPEN");
  w.sessions.set("busy1", { id: "busy1", kind: "background", cwd: working.path, status: "busy", state: "working" });
  w.sessions.set("idle2", { id: "idle2", kind: "background", cwd: merged.path, status: "idle", state: "idle" });
  w.prs.push({ number: 401, state: "MERGED", headRefName: "issue-301-working" }, { number: 402, state: "MERGED", headRefName: "issue-302-merged" });

  const { code, lines } = start([String(ISSUE)], startDeps(w));

  assert.equal(code, 0, lines.join("\n"));
  const text = lines.join("\n");
  assert.match(text, /skipped issue-301-working: session still working/);
  assert.match(text, /removed issue-302-merged \(PR #402\)/);
  assert.equal(existsSync(working.path), true);
  assert.equal(branchThere(w, "issue-301-working"), true);
  assert.equal(w.sessions.has("busy1"), true);
  assert.equal(existsSync(merged.path), false);
  assert.equal(branchThere(w, "issue-302-merged"), false);
  assert.equal(w.sessions.has("idle2"), false);
  assert.equal(w.count("claude", "rm", "busy1"), 0);
  assert.equal(w.count("claude", "rm", "idle2"), 1);
});

test("every call reap.mjs and cleanup.mjs make carries windowsHide: true", async (t) => {
  const w = world();
  t.after(w.cleanup);
  const lane = w.worktree(ISSUE, SLUG);
  w.sessions.set("sess1", { id: "sess1", kind: "background", cwd: lane.path, status: "idle", state: "idle" });
  w.prs.push({ number: 300, state: "MERGED", headRefName: SLUG });

  assert.equal(await reaper(w, "sess1"), 0, reaperLog(w));
  cleanupMerged({ deps: w.cleanupDeps("cleanup") });

  const theirs = w.calls.filter((c) => ["reap", "reap-cleanup", "cleanup"].includes(c.by));
  assert.ok(theirs.length > 10, `only ${theirs.length} calls recorded`);
  assert.ok(theirs.some((c) => c.by === "reap" && c.cmd === "gh"));
  assert.ok(theirs.some((c) => c.by === "reap-cleanup" && c.cmd === "claude" && c.args[0] === "rm"));
  for (const c of theirs) assert.equal(c.options.windowsHide, true, `${c.by}: ${c.cmd} ${c.args.join(" ")}`);
});

test("the fake run records options and starts nothing else", () => {
  const w = world();
  try {
    assert.equal(w.run("git", ["rev-parse", "--is-inside-work-tree"], { windowsHide: true }, "t").trim(), "true");
    assert.deepEqual(w.calls[0].options, { windowsHide: true });
    assert.throws(() => w.run("node", ["-v"]), /unexpected command/);
    assert.throws(() => w.run("gh", ["repo", "delete"]), /unexpected gh call/);
  } finally {
    w.cleanup();
  }
});
