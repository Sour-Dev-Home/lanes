import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PATH_PATTERNS, PATH_SCAN_EXEMPT, SCAN_EXEMPT } from "./preflight.mjs";

// #183: security.yml's file filters and preflight.mjs's SCAN_EXEMPT / PATH_SCAN_EXEMPT must stay in step.
const yml = readFileSync(".github/workflows/security.yml", "utf8");
const run = yml.slice(yml.indexOf("run: |"));

/** Every `grep -zvE '<regex>'` file filter in the job, in order. */
const filters = [...run.matchAll(/grep -zvE '([^']+)'/g)].map((match) => match[1]);

test("the job has exactly two file filters: the shared exemptions, then the sheets folder", () => {
  assert.deepEqual(filters, ["^(\\.github/|.*CLAUDE\\.md$|LICENSE$)", "^vendor/owasp-cheatsheets/sheets/"]);
});

test("the path-only filter names exactly vendor/owasp-cheatsheets/sheets/, matching PATH_SCAN_EXEMPT", () => {
  const [pathOnly] = PATH_SCAN_EXEMPT;
  assert.equal(PATH_SCAN_EXEMPT.length, 1);
  assert.equal(new RegExp(filters[1]).source.replaceAll("\\/", "/"), pathOnly.source.replaceAll("\\/", "/"));
  for (const file of ["vendor/owasp-cheatsheets/sheets/a.md", "vendor/owasp-cheatsheets/INDEX.md", "vendor/other/x.md"]) {
    assert.equal(new RegExp(filters[1]).test(file), pathOnly.test(file), file);
  }
});

test("the shared filter skips the same files as SCAN_EXEMPT", () => {
  const shared = new RegExp(filters[0]);
  for (const file of ["LICENSE", "CLAUDE.md", "a/CLAUDE.md", ".github/x.yml", "docs/LICENSE", "README.md", "vendor/x.md"]) {
    assert.equal(shared.test(file), SCAN_EXEMPT.some((exempt) => exempt.test(file)), file);
  }
});

test("the private patterns are grepped over every scanned file; only the path patterns skip the sheets", () => {
  const privateScan = /\n\s*PII_HITS=\$\(xargs -0 -r grep -H -n -iF -f "\$PII" < "\$FILES"/;
  const pathScan = /\n\s*PATH_HITS=\$\(grep -zvE '\^vendor\/owasp-cheatsheets\/sheets\/' "\$FILES" \| xargs -0 -r grep -H -n -iF -f "\$PATHS"/;
  assert.match(run, privateScan);
  assert.match(run, pathScan);
  // The four shapes come from PATH_PATTERNS (the fifth is preflight's JSON-escaped form), so this file holds none literally.
  const shapes = PATH_PATTERNS.slice(0, 4).map((pattern) => `'${pattern}'`).join(" ");
  assert.ok(run.includes(`printf '%s\\n' ${shapes} > "$PATHS"`), "the path patterns go into their own list");
  assert.ok(!run.includes(">> \"$PII\""), "path patterns must not go into the private list");
});

/**
 * Runs the job's script in a throwaway repo holding `files` ({ path: text }), with PII_PATTERNS set to `secret`.
 * @returns {{ status: number; hits: string[] } | undefined} undefined when no bash with git and GNU grep is at hand
 */
function runJob(files, secret) {
  const dir = mkdtempSync(join(tmpdir(), "security-yml-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${text}\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const script = run.slice("run: |".length).replace(/^ {10}/gm, "");
    const probe = spawnSync("bash", ["-c", "git ls-files -z | grep -zc . >/dev/null"], { cwd: dir });
    if (probe.status !== 0) return undefined;
    const result = spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, PII_PATTERNS: secret }, encoding: "utf8" });
    const hits = result.stdout.split("\n").filter((line) => /^[^:]+:\d+$/.test(line));
    return { status: result.status, hits: hits.sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Built from parts so this file does not contain the path shape literally (the scan would flag it).
const URL_LINE = `fetch('${["", "users", "profile"].join("/")}')`;

test("the job skips the sheets for path patterns only, and still scans every other file for both", (t) => {
  const files = {
    "vendor/owasp-cheatsheets/sheets/CSRF.md": URL_LINE,
    "vendor/owasp-cheatsheets/sheets/with space.md": "an internal-codename line",
    "vendor/owasp-cheatsheets/INDEX.md": URL_LINE,
    "vendor/other/x.md": URL_LINE,
    "README.md": "clean",
  };
  const result = runJob(files, "Internal-Codename");
  if (result === undefined) {
    assert.ok(!process.env.CI, "CI must run this test, not skip it");
    return t.skip("no bash with git and GNU grep on this machine");
  }
  assert.equal(result.status, 1);
  assert.deepEqual(result.hits, [
    "vendor/other/x.md:1",
    "vendor/owasp-cheatsheets/INDEX.md:1",
    "vendor/owasp-cheatsheets/sheets/with space.md:1",
  ]);
});

test("edge: the job passes a clean tree whose only path-like text is in a sheet, with or without the secret", (t) => {
  const files = { "vendor/owasp-cheatsheets/sheets/CSP.md": ["report-uri.com", "home", "hash"].join("/"), "README.md": "clean" };
  for (const secret of ["Internal-Codename", ""]) {
    const result = runJob(files, secret);
    if (result === undefined) {
      assert.ok(!process.env.CI, "CI must run this test, not skip it");
      return t.skip("no bash with git and GNU grep on this machine");
    }
    assert.deepEqual(result, { status: 0, hits: [] }, `secret: ${JSON.stringify(secret)}`);
  }
});

test("the file lists stay NUL-separated end to end", () => {
  assert.match(run, /git ls-files -z \| grep -zvE /);
  for (const grep of run.match(/grep -[a-zA-Z]*v[a-zA-Z]*E? /g) ?? []) assert.match(grep, /z/, grep);
  const xargs = run.match(/xargs [^|)]*/g) ?? [];
  assert.equal(xargs.length, 2);
  for (const call of xargs) assert.match(call, /^xargs -0 /, call);
});
