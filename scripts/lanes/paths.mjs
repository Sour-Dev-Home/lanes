// The file paths an issue claims, and whether two claims collide. Shared by pick.mjs and status.mjs, which used to
// import each other for these (ADR 0008).

import { issuePaths } from "./lib.mjs";

export { issuePaths };

// Two path lists overlap when they share a path, or one names a directory (`dir/`) holding a path the other names.
export function pathsOverlap(a, b) {
  const within = (dir, p) => dir.endsWith("/") && p.startsWith(dir);
  return a.some((x) => b.some((y) => x === y || within(x, y) || within(y, x)));
}
