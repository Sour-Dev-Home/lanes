// scripts/lanes/handover.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handover, handoverComment } from "./handover.mjs";
import { pendingFileHash } from "./lib.mjs";

const HEAD = "a".repeat(40);
const TEAM_CFG = JSON.stringify({ identity: { profile: "team", app: { id: 1, installationId: 2, botLogin: "x[bot]" } } });
const SOLO_CFG = JSON.stringify({ identity: { profile: "solo" } });

// A fake world: `status` is the `--name-status -z` list, `files` maps path to its content at HEAD.
function world({ config = TEAM_CFG, parent = HEAD, branch = "issue-9-x", status = ["M", ".github/workflows/ci.yml"], files = { ".github/workflows/ci.yml": "on: push\n" } } = {}) {
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

test("handover (#595): solo prints that the hand-over is team only and posts nothing", () => {
  const w = world({ config: SOLO_CFG });
  const r = handover(["9"], w.deps);
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /team only/);
  assert.equal(w.posted.length, 0);
  assert.deepEqual(w.calls, []);
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
