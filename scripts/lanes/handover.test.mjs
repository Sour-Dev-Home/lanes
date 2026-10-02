// scripts/lanes/handover.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handover, handoverComment, handoverMode } from "./handover.mjs";
import { TEAM_REQUIRED_MESSAGE, pendingFileHash } from "./lib.mjs";
import { HANDOVER_MARKER, filterDecision, parseHandoverFiles } from "./workflow-apply.mjs";

const WITH_REVIEWER = JSON.stringify({ name: "lanes-workflow-apply", protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "owner" } }] }, { type: "branch_policy" }] });

const HEAD = "a".repeat(40);
const TEAM_CFG = JSON.stringify({ identity: { profile: "team", app: { id: 1, installationId: 2, botLogin: "x[bot]" } } });
const SOLO_CFG = JSON.stringify({ identity: { profile: "solo" } });

// A fake world: `status` is the `--name-status -z` list, `files` maps path to its content at HEAD.
function world({ config = TEAM_CFG, parent = HEAD, branch = "issue-9-x", status = ["M", ".github/workflows/ci.yml"], files = { ".github/workflows/ci.yml": "on: push\n" }, environment } = {}) {
  const calls = [];
  const posted = [];
  const deps = {
    readConfig: () => config,
    git: (args, opts) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse") return `${parent}\n`;
      if (args[0] === "diff") return status.join("\0") + "\0";
      if (args[0] === "show") {
        const p = args[1].slice("HEAD:".length);
        if (!(p in files)) throw new Error("fatal: path does not exist");
        return opts?.raw ? Buffer.from(files[p]) : files[p];
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    gh: (args) => {
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "repo") return "owner/lanes\n";
      if (args[0] === "pr") return JSON.stringify({ headRefName: branch, headRefOid: HEAD });
      // The environment read (ADR 0029 part 7): a string is the answer, an Error is a failed read, undefined is a 404.
      if (args[0] === "api" && args[1] === "repos/owner/lanes/environments/lanes-workflow-apply") {
        if (environment === undefined || environment instanceof Error) throw environment ?? new Error("gh: Not Found (HTTP 404)");
        return environment;
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
    comment: (pr, body) => posted.push({ pr, body }),
  };
  return { deps, posted, calls };
}

test("handoverComment (#595): an existing file gets the edit link, the full content in a fence and the warning", () => {
  const body = handoverComment({ repo: "owner/lanes", branch: "issue-9-x", files: [{ path: ".github/workflows/ci.yml", status: "M", text: "on: push\njobs: {}\n" }] });
  assert.ok(body.includes("https://github.com/owner/lanes/edit/issue-9-x/.github/workflows/ci.yml"));
  assert.ok(body.includes("```yaml\non: push\njobs: {}\n```"));
  assert.match(body, /Read each file before you click Commit changes/);
  assert.match(body, /runs any push-triggered workflow/);
});

test("handoverComment (#595): a new file gets the new/ link with ?filename=", () => {
  const body = handoverComment({ repo: "owner/lanes", branch: "issue-9-x", files: [{ path: ".github/workflows/new.yml", status: "A", text: "on: push\n" }] });
  assert.ok(body.includes("https://github.com/owner/lanes/new/issue-9-x?filename=.github/workflows/new.yml"));
  assert.ok(!body.includes("/edit/"));
});

test("handoverComment (#595): edge: content holding a code fence gets a longer fence; a branch with a slash keeps it", () => {
  const text = "run: |\n  echo '```'\n  echo '````'\n";
  const body = handoverComment({ repo: "o/r", branch: "feat/x y", files: [{ path: ".github/workflows/a.yml", status: "M", text }] });
  assert.ok(body.includes("`````yaml\n"), "a fence of five backticks, one longer than the longest run inside");
  assert.ok(body.includes("/edit/feat/x%20y/.github/workflows/a.yml"));
});

test("handover (#595): posts one comment for the final commit's files and prints each pendingFileHash", () => {
  const w = world({ status: ["M", ".github/workflows/ci.yml", "A", ".github/workflows/new.yml"], files: { ".github/workflows/ci.yml": "on: push\r\n", ".github/workflows/new.yml": "on: pull_request\n" } });
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].pr, "9");
  assert.ok(w.posted[0].body.includes("/edit/issue-9-x/.github/workflows/ci.yml"));
  assert.ok(w.posted[0].body.includes("/new/issue-9-x?filename=.github/workflows/new.yml"));
  const pending = JSON.parse(r.lines.find((l) => l.startsWith("pending: ")).slice("pending: ".length));
  assert.deepEqual(pending, [
    { path: ".github/workflows/ci.yml", sha256: pendingFileHash("on: push\n") },
    { path: ".github/workflows/new.yml", sha256: pendingFileHash("on: pull_request\n") },
  ]);
  assert.ok(w.calls.includes("show HEAD:.github/workflows/ci.yml"), "content comes from git show HEAD:<path>");
});

test("handover (#595): a solo or missing identity is refused with the team-required message and posts nothing", () => {
  for (const config of [SOLO_CFG, "{}"]) {
    const w = world({ config });
    const r = handover(["9"], w.deps);
    assert.equal(r.code, 2);
    assert.ok(r.lines[0].startsWith(TEAM_REQUIRED_MESSAGE), r.lines[0]);
    assert.equal(w.posted.length, 0);
    assert.deepEqual(w.calls, []);
  }
});

test("handover (#595): refuses when HEAD~1 is not the PR's head on GitHub", () => {
  const w = world({ parent: "b".repeat(40) });
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /HEAD~1 is not the PR's head on GitHub/);
  assert.equal(w.posted.length, 0);
});

test("handover (#595): refuses when HEAD changes anything outside .github/workflows/", () => {
  const w = world({ status: ["M", ".github/workflows/ci.yml", "M", "scripts/lanes/x.mjs"] });
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /outside \.github\/workflows\//);
  assert.equal(w.posted.length, 0);
});

test("handover (#595): a workflow-file deletion is refused with the browser instruction", () => {
  const r = handover(["9"], world({ status: ["D", ".github/workflows/old.yml"] }).deps);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /deletes \.github\/workflows\/old\.yml.*delete the file in the browser/);
});

test("handover (#595): edge: no change in HEAD, a rename-like status, an unsafe path and an empty file are refused", () => {
  for (const [name, opts, re] of [
    ["no change", { status: [] }, /changes no file/],
    ["a copy status", { status: ["C", ".github/workflows/a.yml"] }, /cannot carry/],
    ["a traversal path", { status: ["M", ".github/workflows/../x.yml"] }, /cannot carry/],
    ["a path with a space", { status: ["M", ".github/workflows/a b.yml"], files: { ".github/workflows/a b.yml": "x\n" } }, /cannot carry/],
    ["the bare directory", { status: ["M", ".github/workflows/"] }, /cannot carry/],
    ["an empty file", { status: ["A", ".github/workflows/e.yml"], files: { ".github/workflows/e.yml": "\n\n" } }, /empty or not valid UTF-8/],
  ]) {
    const w = world(opts);
    const r = handover(["9"], w.deps);
    assert.equal(r.code, 1, `${name}: ${r.lines.join("\n")}`);
    assert.match(r.lines[0], re, name);
    assert.equal(w.posted.length, 0, name);
  }
});

test("handover (#595): edge: invalid UTF-8, an oversized comment and an unsafe branch are refused", () => {
  const bad = world({ status: ["A", ".github/workflows/b.yml"] });
  const git = bad.deps.git;
  bad.deps.git = (args, opts) => (args[0] === "show" ? Buffer.from([0xff, 0xfe, 0x41]) : git(args, opts));
  assert.match(handover(["9"], bad.deps).lines[0], /not valid UTF-8/);
  const big = world({ files: { ".github/workflows/ci.yml": "x".repeat(70000) } });
  assert.match(handover(["9"], big.deps).lines[0], /too large/);
  assert.equal(big.posted.length, 0);
  for (const branch of ["-x", "a/../b", "a b", "a;b"]) {
    const w = world({ branch });
    assert.equal(handover(["9"], w.deps).code, 1, branch);
    assert.equal(w.posted.length, 0, branch);
  }
});

test("handover (#607): refuses hidden, bidi and control characters, naming the file and posting nothing", () => {
  const classes = {
    "bidi embedding U+202A": "\u202a",
    "bidi override U+202E": "\u202e",
    "bidi isolate U+2066": "\u2066",
    "bidi isolate U+2069": "\u2069",
    "bidi mark U+200F": "\u200f",
    "zero-width space U+200B": "\u200b",
    "zero-width joiner U+200D": "\u200d",
    "word joiner U+2060": "\u2060",
    "byte order mark U+FEFF": "\ufeff",
    "NUL": "\u0000",
    "escape": "\u001b",
    "backspace": "\u0008",
    "DEL": "\u007f",
    "C1 control U+0085": "\u0085",
    "deprecated format U+206A": "\u206a",
    "unassigned format U+2065": "\u2065",
    "soft hyphen": "\u00ad",
    "grapheme joiner": "\u034f",
    "Hangul filler U+3164": "\u3164",
    "variation selector U+FE0F": "\ufe0f",
    "interlinear annotation U+FFFA": "\ufffa",
    "tag character U+E0041": "\u{e0041}",
    "variation selector U+E0100": "\u{e0100}",
  };
  for (const [name, ch] of Object.entries(classes)) {
    const w = world({ files: { ".github/workflows/ci.yml": `on: push\nname: a${ch}b\n` } });
    const r = handover(["9"], w.deps);
    assert.equal(r.code, 1, `${name}: ${r.lines.join("\n")}`);
    assert.match(r.lines[0], /\.github\/workflows\/ci\.yml/, name);
    assert.match(r.lines[0], /hidden|control/, name);
    assert.equal(w.posted.length, 0, name);
  }
});

test("handover (#607): edge: each range edge is refused and its neighbour outside the range is accepted", () => {
  const run = (cp) => {
    const w = world({ files: { ".github/workflows/ci.yml": `on: push\nname: a${String.fromCodePoint(cp)}b\n` } });
    return { r: handover(["9"], w.deps), w };
  };
  for (const cp of [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x180e, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202b, 0x202c, 0x202d, 0x2067, 0x2068, 0x206f, 0x3164, 0xfe00, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0xe0000, 0xe007f, 0xe0100, 0xe01ef]) {
    const { r, w } = run(cp);
    assert.equal(r.code, 1, `U+${cp.toString(16)} refused`);
    assert.equal(w.posted.length, 0);
  }
  for (const cp of [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0xa0, 0xa1, 0x2027, 0x202f, 0x2070, 0x3000, 0xe0080, 0xe00ff, 0xe01f0, 0x1f600]) {
    const { r, w } = run(cp);
    assert.equal(r.code, 0, `U+${cp.toString(16)} accepted: ${r.lines.join("\n")}`);
    assert.equal(w.posted.length, 1);
  }
});

test("handover (#607): edge: only tab, LF and CR controls are accepted; the second file's name is the one refused", () => {
  const ok = world({ files: { ".github/workflows/ci.yml": "on: push\r\njobs:\n\tx: 1\n" } });
  assert.equal(handover(["9"], ok.deps).code, 0);
  assert.equal(ok.posted.length, 1);
  const two = world({
    status: ["M", ".github/workflows/ci.yml", "A", ".github/workflows/new.yml"],
    files: { ".github/workflows/ci.yml": "on: push\n", ".github/workflows/new.yml": "on: x\u202e\n" },
  });
  const r = handover(["9"], two.deps);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /new\.yml/);
  assert.equal(two.posted.length, 0);
});

test("handover (#607): edge: the comment is accepted at exactly 60000 characters and refused one over", () => {
  const path = ".github/workflows/ci.yml";
  const overhead = handoverComment({ repo: "owner/lanes", branch: "issue-9-x", files: [{ path, status: "M", text: "" }] }).length;
  const at = world({ files: { [path]: "x".repeat(60000 - overhead) } });
  assert.equal(handover(["9"], at.deps).code, 0);
  assert.equal(at.posted.length, 1);
  assert.equal(at.posted[0].body.length, 60000);
  const over = world({ files: { [path]: "x".repeat(60000 - overhead + 1) } });
  const r = handover(["9"], over.deps);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /too large/);
  assert.equal(over.posted.length, 0);
});

test("handover (#595): edge: a bad or missing PR number is a usage error and reads nothing", () => {
  for (const argv of [[], ["x"], ["0"], ["9", "10"], ["-1"], ["9;rm"]]) {
    const w = world();
    const r = handover(argv, w.deps);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.deepEqual(w.calls, []);
  }
});

test("handover (#649): with a required reviewer the comment says Approve and deploy, still lists each file and has no editor link", () => {
  const w = world({ environment: WITH_REVIEWER, status: ["M", ".github/workflows/ci.yml", "A", ".github/workflows/new.yml"], files: { ".github/workflows/ci.yml": "on: push\n", ".github/workflows/new.yml": "on: pull_request\n" } });
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 0, r.lines.join("\n"));
  const body = w.posted[0].body;
  assert.match(body, /Approve and deploy/);
  assert.ok(body.includes("https://github.com/owner/lanes/actions/workflows/lanes-workflow-apply.yml"));
  assert.ok(body.includes("`.github/workflows/ci.yml`") && body.includes("```yaml\non: push\n```"));
  assert.ok(body.includes("`.github/workflows/new.yml`") && body.includes("```yaml\non: pull_request\n```"));
  assert.doesNotMatch(body, /web editor|\/edit\/|\/new\//);
  assert.match(r.lines[0], /one-click/);
  assert.ok(r.lines.some((l) => l.startsWith("pending: ")), "the pending line is still printed");
});

test("handover (#649): without the environment the comment is today's copy-paste text", () => {
  const w = world();
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 0);
  assert.match(w.posted[0].body, /^### Workflow change to commit in GitHub's web editor/);
  assert.match(w.posted[0].body, /Read each file before you click Commit changes/);
  assert.doesNotMatch(w.posted[0].body, /Approve and deploy/);
  assert.match(r.lines[0], /copy-paste/);
});

test("handover (#649): a failed environment read falls back to copy-paste and never stops the hand-over", () => {
  for (const environment of [new Error("gh: HTTP 502"), "<html>not json</html>", "null", "{}"]) {
    const w = world({ environment });
    const r = handover(["9"], w.deps);
    assert.equal(r.code, 0, String(environment));
    assert.match(w.posted[0].body, /web editor/);
    assert.match(r.lines[0], /copy-paste/);
  }
});

test("handoverMode (#649): edge: only a required_reviewers rule with a reviewer counts", () => {
  const mode = (answer) => handoverMode({ gh: () => answer }, "owner/lanes");
  assert.equal(mode(WITH_REVIEWER), "one-click");
  assert.equal(mode(JSON.stringify({ protection_rules: [{ type: "required_reviewers", reviewers: [] }] })), "copy-paste");
  assert.equal(mode(JSON.stringify({ protection_rules: [{ type: "wait_timer", reviewers: [{ type: "User" }] }] })), "copy-paste");
  assert.equal(mode(JSON.stringify({ protection_rules: [{ type: "wait_timer" }, { type: "branch_policy" }] })), "copy-paste");
  assert.equal(mode(JSON.stringify({ protection_rules: "x" })), "copy-paste");
  assert.equal(handoverMode({ gh: () => { throw new Error("boom"); } }, "owner/lanes"), "copy-paste");
});

test("handover (#649): both modes' comments start with the marker workflow-apply matches and parse back to the same files", () => {
  const text = "run: |\n  echo '```'\n";
  const files = [{ path: ".github/workflows/a.yml", status: "M", text }, { path: ".github/workflows/b.yml", status: "A", text: "on: push\n" }];
  for (const mode of ["one-click", "copy-paste"]) {
    const body = handoverComment({ repo: "o/r", branch: "b", files, mode });
    assert.ok(body.startsWith(HANDOVER_MARKER), mode);
    assert.deepEqual(parseHandoverFiles(body), { files: [{ path: ".github/workflows/a.yml", text: text.replace(/\n+$/, "") }, { path: ".github/workflows/b.yml", text: "on: push" }] }, mode);
  }
  const identity = { profile: "team", app: { id: 1, installationId: 2, botLogin: "x[bot]" } };
  const body = handoverComment({ repo: "o/r", branch: "b", files, mode: "one-click" });
  assert.equal(filterDecision({ comment: { body, author: { login: "x[bot]", type: "Bot" } }, isPr: true, identity }).go, true);
});

test("handover (#595): edge: an unreadable config or a failing git or gh call is an error, never a post", () => {
  const cfg = world();
  cfg.deps.readConfig = () => "{ not json";
  assert.equal(handover(["9"], cfg.deps).code, 2);
  const failing = world();
  failing.deps.gh = () => {
    throw new Error("gh: HTTP 502\nsecret-looking second line");
  };
  const r = handover(["9"], failing.deps);
  assert.equal(r.code, 2);
  assert.equal(r.lines.join("\n").includes("secret-looking"), false, "only the first line of an error is shown");
  assert.equal(failing.posted.length, 0);
});
