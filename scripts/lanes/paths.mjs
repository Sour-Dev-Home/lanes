// The file paths an issue claims, and whether two claims collide. Shared by pick.mjs and status.mjs, which used to
// import each other for these (ADR 0008).

const cleanPath = (token) =>
  token
    .replace(/^[("'[]+|[)"'\].,;:]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\*+$/, "");
// Only repo-relative paths are claimed: an email, a backslash path, a URI scheme or drive letter (`file:///C:/x`, `C:`),
// a leading `/`, `~`, `%` or `$` (an absolute or home path) or a `..` segment never is.
const notRepoRelative = (p) => /[@\\]/.test(p) || /^([a-z][a-z0-9+.-]*:|[/~%$])/i.test(p) || p.split("/").includes("..");
const looksLikePath = (p) => p && !/\s/.test(p) && !/^(-|https?:)/.test(p) && !notRepoRelative(p) && (p.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(p));

// The file paths an issue names: backticked or bare tokens with a `/` or a file extension, read from its Interface
// contract and the "In:" part of its Scope (anything after "Out:" is ignored). A trailing `*` glob reads as its directory.
export function issuePaths({ contract = "", scope = "" }) {
  const inPart = scope.split(/(?<![\w-])Out:/i)[0].replace(/^[\s\S]*?(?<![\w-])In:/i, "");
  // A contract of `none (reads `x` from #N)` only reads x, so the note right after `none` names no path to claim.
  const owned = contract.replace(/^\s*none\s*\((?:[^()]|\([^()]*\))*\)/i, "none");
  const paths = [];
  for (const text of [owned, inPart]) {
    for (const [, quoted, bare] of text.matchAll(/`([^`]+)`|(\S+)/g)) {
      const p = cleanPath(quoted ?? bare);
      if (looksLikePath(p) && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

// Two path lists overlap when they share a path, or one names a directory (`dir/`) holding a path the other names.
export function pathsOverlap(a, b) {
  const within = (dir, p) => dir.endsWith("/") && p.startsWith(dir);
  return a.some((x) => b.some((y) => x === y || within(x, y) || within(y, x)));
}
