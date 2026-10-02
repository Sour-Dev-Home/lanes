// The file paths an issue claims, and whether two claims collide. Shared by pick.mjs and status.mjs, which used to
// import each other for these (ADR 0008).

// Both live in lib.mjs (#635), which the gate may import; they are re-exported here for their existing callers.
export { issuePaths, pathsOverlap } from "./lib.mjs";
