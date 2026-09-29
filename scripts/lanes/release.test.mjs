// scripts/lanes/release.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changelogSection, main } from "./release.mjs";

const CHANGELOG = "# Changelog\n\n## [0.2.0] - 2026-10-01\n\nSecond.\n\n- b\n\n## [0.1.0] - 2026-09-29\n\nFirst.\n";

/** A fake io: `onMain` says whether the tag is an ancestor of origin/main. */
const fake = ({ version = "0.2.0", changelog = CHANGELOG, onMain = true } = {}) => {
  const calls = [];
  return {
    calls,
    readText: (p) => {
      if (p === "package.json") return JSON.stringify({ version });
      if (p === "CHANGELOG.md") {
        if (changelog === null) throw new Error("ENOENT");
        return changelog;
      }
      throw new Error(`unexpected read ${p}`);
    },
    git: (args) => {
      calls.push(args);
      if (!onMain) throw new Error("exit 1");
      return "";
    },
  };
};

test("a valid tag prints the version's section and exits 0", () => {
  const io = fake();
  assert.deepEqual(main(["v0.2.0"], io), { code: 0, notes: "Second.\n\n- b" });
  assert.deepEqual(io.calls, [["merge-base", "--is-ancestor", "refs/tags/v0.2.0^{commit}", "refs/remotes/origin/main"]]);
});

test("a tag whose commit is not on origin/main exits 1", () => {
  const r = main(["v0.2.0"], fake({ onMain: false }));
  assert.equal(r.code, 1);
  assert.match(r.message, /not a commit on origin\/main/);
});

test("a tag that does not match package.json's version exits 1", () => {
  const r = main(["v0.1.0"], fake());
  assert.equal(r.code, 1);
  assert.match(r.message, /does not match package\.json version 0\.2\.0/);
});

test("a version with no CHANGELOG section exits 1", () => {
  const r = main(["v0.3.0"], fake({ version: "0.3.0" }));
  assert.equal(r.code, 1);
  assert.match(r.message, /no non-empty "## \[0\.3\.0\]" section/);
});

test("a missing CHANGELOG.md exits 1", () => {
  assert.equal(main(["v0.2.0"], fake({ changelog: null })).code, 1);
});

test("--help and -h print the usage on stdout, exit 0 and touch neither git nor the filesystem", () => {
  for (const argv of [["--help"], ["-h"], ["v0.2.0", "--help"]]) {
    const io = fake();
    const r = main(argv, io);
    assert.equal(r.code, 0);
    assert.match(r.notes, /^usage: node scripts\/lanes\/release\.mjs <tag>$/);
    assert.deepEqual(io.calls, []);
  }
});

test("an unknown flag or extra argument exits 1 naming it, with the usage, before git is touched", () => {
  for (const [argv, name] of [[["--force"], "--force"], [["v0.2.0", "extra"], "extra"], [["v0.2.0", "--publish"], "--publish"]]) {
    const io = fake();
    const r = main(argv, io);
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.message, `unknown argument: ${name}\nusage: node scripts/lanes/release.mjs <tag>`);
    assert.deepEqual(io.calls, []);
  }
});

test("malformed tags exit 1 before git or the filesystem is touched", () => {
  for (const tag of ["0.2.0", "v0.2", "v1.2.3.4", "vx", "v0.2.0;rm", "v0.2.0^{}", "-v0.2.0", "v0.2.0\nv0.2.0", "", undefined]) {
    const io = fake();
    const r = main([tag], io);
    assert.equal(r.code, 1, String(tag));
    assert.match(r.message, /malformed tag/);
    assert.deepEqual(io.calls, []);
  }
});

test("edge: a pre-release tag matches its own section and not the plain version's", () => {
  const changelog = "## [1.0.0-rc.1]\n\nRC.\n\n## [1.0.0]\n\nFinal.\n";
  assert.deepEqual(main(["v1.0.0-rc.1"], fake({ version: "1.0.0-rc.1", changelog })), { code: 0, notes: "RC." });
  assert.equal(changelogSection(changelog, "1.0.0"), "Final.");
});

test("edge: an empty section, CRLF line endings and a last section are handled", () => {
  assert.equal(changelogSection("## [1.0.0]\n\n## [0.9.0]\n\nx\n", "1.0.0"), null);
  assert.equal(changelogSection("## [1.0.0]\r\n\r\nA\r\nB\r\n\r\n## [0.9.0]\r\n", "1.0.0"), "A\nB");
  assert.equal(changelogSection("## [1.0.0]\nlast\n", "1.0.0"), "last");
  assert.equal(changelogSection("## [1.0.01]\nx\n", "1.0.0"), null);
});

test("edge: an unreadable package.json exits 1", () => {
  const io = { ...fake(), readText: () => "not json" };
  assert.equal(main(["v0.2.0"], io).code, 1);
});

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

test("release.yml triggers on v* tag pushes only", () => {
  assert.match(workflow, /^on:\n {2}push:\n {4}tags:\n {6}- "v\*"\n/m);
  assert.doesNotMatch(workflow, /pull_request|workflow_dispatch|branches:/);
});

test("release.yml has contents: write permissions and nothing else", () => {
  assert.match(workflow, /^permissions:\n {2}contents: write\n(?! {2}\S)/m);
  assert.equal((workflow.match(/^\s*permissions:/gm) ?? []).length, 1);
});

test("release.yml pins every action by SHA", () => {
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 1);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test("release.yml fetches origin/main, runs release.mjs and creates the release from its output", () => {
  assert.match(workflow, /git fetch origin main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /node scripts\/lanes\/release\.mjs "\$TAG" > "\$NOTES"/);
  assert.match(workflow, /gh release create "\$TAG" .*--notes-file "\$NOTES"/);
  assert.match(workflow, /case "\$TAG" in \*-\*\) PRE=--prerelease ;; esac/, "a hyphenated tag is a pre-release");
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{/, "no expression interpolated into a shell command");
});

test("lanes.config.json maps scripts/lanes/release. into the install module", () => {
  const cfg = JSON.parse(readFileSync("lanes.config.json", "utf8"));
  const install = cfg.modules.entries.find((e) => e.id === "install");
  assert.ok(install.paths.includes("scripts/lanes/release."));
});
