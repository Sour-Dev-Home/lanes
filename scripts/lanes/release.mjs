// scripts/lanes/release.mjs
// Validates a release tag and prints its CHANGELOG section, for .github/workflows/release.yml (ADR 0017).
// Usage: node scripts/lanes/release.mjs <tag>. Exit 0: the section is printed on stdout. 1: a one-line reason on stderr.
// The tag must be `v` plus package.json's version, its commit must be an ancestor of origin/main, and CHANGELOG.md
// must have a `## [<version>]` section with content.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Strict on purpose: the tag reaches git as an argument, so it must not be able to start with `-` or hold a `:` or `^`.
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

/** @returns {string | null} the text under `## [<version>]` up to the next `## ` heading, trimmed; null when absent or empty */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `## [${version}]` || l.startsWith(`## [${version}] `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

/**
 * `io` supplies `readText(path)` and `git(args)` (stdout, throwing on a non-zero exit); tests pass fakes.
 * @returns {{ code: 0, notes: string } | { code: 1, message: string }}
 */
const USAGE = "usage: node scripts/lanes/release.mjs <tag>";

export function main(argv, io = realIo) {
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, notes: USAGE };
  const unknown = argv.find((a, i) => i > 0 || (typeof a === "string" && a.startsWith("--")));
  if (unknown !== undefined) return { code: 1, message: `unknown argument: ${unknown}\n${USAGE}` };
  const tag = argv[0];
  const m = typeof tag === "string" ? TAG.exec(tag) : null;
  if (!m) return { code: 1, message: `release: malformed tag ${JSON.stringify(tag ?? "")}: expected v<major>.<minor>.<patch>` };
  const version = m[1];

  let pkgVersion;
  try {
    pkgVersion = JSON.parse(io.readText("package.json")).version;
  } catch {
    return { code: 1, message: "release: cannot read the version from package.json" };
  }
  if (pkgVersion !== version) return { code: 1, message: `release: tag ${tag} does not match package.json version ${pkgVersion}` };

  try {
    io.git(["merge-base", "--is-ancestor", `refs/tags/${tag}^{commit}`, "refs/remotes/origin/main"]);
  } catch {
    return { code: 1, message: `release: ${tag} is not a commit on origin/main` };
  }

  let changelog;
  try {
    changelog = io.readText("CHANGELOG.md");
  } catch {
    return { code: 1, message: "release: cannot read CHANGELOG.md" };
  }
  const notes = changelogSection(changelog, version);
  if (notes === null) return { code: 1, message: `release: CHANGELOG.md has no non-empty "## [${version}]" section` };
  return { code: 0, notes };
}

const realIo = {
  readText: (p) => readFileSync(p, "utf8"),
  git: (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.code === 0) console.log(r.notes);
  else console.error(r.message);
  process.exitCode = r.code;
}
