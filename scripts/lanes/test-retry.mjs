// The full suite for the merge queue and main (#637): run every test file as `npm test` does, rerun only the files that
// failed, once, and report a test that failed then passed as flaky instead of failing the run.
// Usage: node scripts/lanes/test-retry.mjs [files...]   (no files: every scripts/**/*.test.mjs; exit 0: all passed, or every failure passed on the rerun; exit 1: a failure stayed)
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";

const posix = (p) => p.split("\\").join("/");

// Every `*.test.mjs` under `dir`, sorted: the files `node --test "scripts/**/*.test.mjs"` would run.
export function suiteFiles(dir = "scripts") {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(join(d, e.name));
      } else if (e.name.endsWith(".test.mjs")) out.push(posix(join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

// Run `files` with node:test and report `{ failures: [{ file, name }] }`: one entry per failed test, never one per
// parent suite whose only failure is a failed subtest. A test file that crashes counts as one failure named by the file.
export async function runFiles(files, { out = process.stdout } = {}) {
  const failures = [];
  const stream = run({ files, concurrency: true });
  stream.on("test:fail", (data) => {
    if (data.details?.error?.failureType === "subtestsFailed") return;
    const file = data.file ? posix(relative(process.cwd(), data.file)) : data.name;
    failures.push({ file, name: String(data.name) });
  });
  await new Promise((resolve, reject) => {
    const sink = stream.compose(spec);
    sink.on("data", (chunk) => out.write(chunk));
    sink.on("end", resolve);
    sink.on("error", reject);
  });
  return { failures };
}

const keyOf = (f) => `${f.file}\u0000${f.name}`;
// A workflow command ends at the line, and `%` starts an escape: keep the annotation to one line.
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, " ").replace(/\n/g, " ");

/**
 * The retry policy. `runner(files)` returns `{ failures }`. Runs `files` once; reruns only the failed files, once, and
 * never again. `{ code, flaky, failed, lines }`: `flaky` are the tests that failed then passed, `failed` those that failed
 * the rerun, `lines` the warning lines to print.
 */
export async function testWithRetry(files, runner) {
  const first = await runner(files);
  if (first.failures.length === 0) return { code: 0, flaky: [], failed: [], lines: [] };
  const rerunFiles = [...new Set(first.failures.map((f) => f.file))];
  const second = await runner(rerunFiles);
  const stillFailing = new Set(second.failures.map(keyOf));
  // any failure on the rerun stays a failure, even one the first run did not report
  const failed = second.failures;
  const flaky = first.failures.filter((f) => !stillFailing.has(keyOf(f)));
  const lines = flaky.map((f) => `::warning title=lanes-flaky::${escapeData(f.file)} :: ${escapeData(f.name)}`);
  return { code: failed.length === 0 ? 0 : 1, flaky, failed, lines };
}

async function main() {
  const given = process.argv.slice(2);
  const result = await testWithRetry(given.length > 0 ? given : suiteFiles(), runFiles);
  for (const line of result.lines) console.log(line);
  if (result.failed.length > 0) {
    console.error(`test-retry: ${result.failed.length} test(s) failed again on the rerun:`);
    for (const f of result.failed) console.error(`  ${f.file} :: ${f.name}`);
  }
  process.exitCode = result.code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
