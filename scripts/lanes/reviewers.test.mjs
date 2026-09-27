import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "reviewers.mjs");
const CONFIG = {
  requiredChecks: ["verify"],
  paths: { skip: ["^docs/", "^\\.gitignore$"], contract: ["^contracts/"], sensitive: ["(^|/)auth/"], ui: ["\\.css$"] },
};
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

// A throwaway repo whose origin/main is the first commit; the branch then adds `committed` in a second commit.
function inRepo(fn, committed = { "src/app.js": "x\n" }) {
  const root = mkdtempSync(join(tmpdir(), "lanes-reviewers-"));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  const write = (file, text = "x\n") => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    git("init", "-q", "-b", "main");
    write("lanes.config.json", JSON.stringify(CONFIG));
    write(".gitignore", ".lanes/\n");
    write("src/style.css", "a{}\n");
    write("auth/old.js");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    for (const [file, text] of Object.entries(committed)) write(file, text);
    git("add", "-A");
    git("commit", "-q", "-m", "branch");
    return fn({ root, git, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const run = (root, tier = "quick") => spawnSync(process.execPath, [SCRIPT, tier], { cwd: root, encoding: "utf8" });
const reviewers = (root, tier) => {
  const r = run(root, tier);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
};

// AC2: a clean tree prints what the committed diff alone needs.
test("clean worktree: output comes from origin/main...HEAD only", () => {
  inRepo(({ root }) => assert.deepEqual(reviewers(root), ["test-hunter"]));
  inRepo(({ root }) => assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]), { "auth/login.js": "x\n" });
  inRepo(({ root }) => assert.deepEqual(reviewers(root, "skip"), ["none"]), { "docs/a.md": "x\n" });
});

// AC1 + AC3: uncommitted changes are classified together with the committed diff.
test("dirty worktree: an unstaged edit to a tracked file counts", () => {
  inRepo(({ root, write }) => {
    write("src/style.css", "b{}\n");
    assert.deepEqual(reviewers(root), ["test-hunter", "ui-reviewer"]);
  });
});

test("dirty worktree: a staged new file counts", () => {
  inRepo(({ root, write, git }) => {
    write("auth/token.js");
    git("add", "auth/token.js");
    assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]);
  });
});

test("dirty worktree: an untracked file counts", () => {
  inRepo(({ root, write }) => {
    write("contracts/api.json", "{}\n");
    assert.deepEqual(reviewers(root), ["test-hunter", "architecture-advisor"]);
  });
});

test("dirty worktree: committed and uncommitted findings are merged", () => {
  inRepo(
    ({ root, write }) => {
      write("src/style.css", "b{}\n");
      assert.deepEqual(reviewers(root), ["test-hunter", "ui-reviewer", "security-reviewer"]);
    },
    { "auth/login.js": "x\n" },
  );
});

// edge: a dirty non-skip file on a skip-only branch is not skip.
test("edge: tier skip with an uncommitted non-skip file prints NOT SKIP", () => {
  inRepo(
    ({ root, write }) => {
      write("src/new.js");
      assert.match(reviewers(root, "skip")[0], /^NOT SKIP/);
    },
    { "docs/a.md": "x\n" },
  );
});

// edge: ignored files (the lane's own .lanes/verdicts) do not count.
test("edge: gitignored untracked files are not classified", () => {
  inRepo(
    ({ root, write }) => {
      write(".lanes/verdicts/auth/x.json", "{}\n");
      assert.deepEqual(reviewers(root, "skip"), ["none"]);
    },
    { "docs/a.md": "x\n" },
  );
});

// edge: an unstaged deletion counts by its old path.
test("edge: an uncommitted deletion counts", () => {
  inRepo(({ root }) => {
    unlinkSync(join(root, "auth", "old.js"));
    assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]);
  });
});

// edge: a staged rename out of a sensitive path still lists the old name.
test("edge: a staged rename counts both names", () => {
  inRepo(({ root, git }) => {
    mkdirSync(join(root, "lib"));
    renameSync(join(root, "auth", "old.js"), join(root, "lib", "old.js"));
    git("add", "-A");
    assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]);
  });
});

// edge: git quotes non-ASCII paths unless -z; a quoted path would miss ^-anchored patterns.
test("edge: non-ASCII and spaced paths are classified unquoted", () => {
  inRepo(({ root }) => assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]), { "auth/señal file.js": "x\n" });
  inRepo(({ root, write }) => {
    write("auth/ñ.js");
    assert.deepEqual(reviewers(root), ["test-hunter", "security-reviewer"]);
  });
});

test("edge: an unknown tier is refused", () => {
  inRepo(({ root }) => {
    const r = run(root, "huge");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage: reviewers\.mjs/);
  });
});
