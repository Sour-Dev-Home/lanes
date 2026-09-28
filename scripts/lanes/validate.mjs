// scripts/lanes/validate.mjs
// One attempt of a validation-loop criterion (ADR 0012): runs the criterion's command, reads a number from its output
// and appends the attempt to .lanes/validate/<N>.jsonl. The command runs as an argument array, never through a shell.
// Usage: node scripts/lanes/validate.mjs --issue N --criterion I   (I is the 1-based acceptance criterion)
// Exit 0: threshold met. 1: not met, attempts remain. 2: not met and the cap is reached. 3: cannot run (bad usage, an
// unreadable issue, a plain or malformed criterion).
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIssueForm, parseValidation } from "./lib.mjs";

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** Splits a command line into an argument array on whitespace, keeping "double" and 'single' quoted runs together. */
export function splitCommand(command) {
  return [...String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const compare = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

const readIssue = (n) => JSON.parse(execFileSync("gh", ["issue", "view", String(n), "--json", "body"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).body;

// Characters cmd.exe would interpret even inside double quotes (or that break the quoting); an argument with one is refused.
const CMD_UNSAFE = /["%^&|<>!\r\n\0]/;

/**
 * On Windows, npm and npx are .cmd shims that Node refuses to spawn without a shell (ENOENT or EINVAL). Finds the
 * command on PATH; a .cmd or .bat is run as `cmd.exe /d /s /c "<shim> "<arg>" ..."` with every argument quoted and
 * any argument holding a cmd.exe metacharacter refused, so issue text is never interpreted by a shell. Anything else
 * (an .exe, another platform, a command not found) is returned unchanged for spawn to run or report.
 * @returns {{ file: string, args: string[], verbatim: boolean }}
 */
export function resolveCommand(argv, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const plain = { file: argv[0], args: argv.slice(1), verbatim: false };
  if (platform !== "win32" || /[\\/]/.test(argv[0])) return plain;
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = `${dir.replace(/[\\/]+$/, "")}\\${argv[0]}${ext}`;
      if (!exists(full)) continue;
      if (!/\.(cmd|bat)$/i.test(full)) return plain;
      const parts = [full, ...argv.slice(1)];
      const bad = parts.find((p) => CMD_UNSAFE.test(p));
      if (bad !== undefined) throw new Error(`unsafe character in a command argument for ${argv[0]}: ${JSON.stringify(bad)}`);
      return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${parts.map((p) => `"${p}"`).join(" ")}"`], verbatim: true };
    }
  }
  return plain;
}

const run = (argv) => {
  const { file, args, verbatim } = resolveCommand(argv);
  return spawnSync(file, args, { encoding: "utf8", shell: false, windowsVerbatimArguments: verbatim, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
};

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Command output reaches the reason, so strip control characters and bound its length before it is logged or printed.
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);

function measure(v, result) {
  if (result.error) return { reason: `command failed to run: ${clean(result.error.message)}` };
  if (result.status !== 0) return { reason: `command exited ${result.status ?? `by signal ${result.signal}`}` };
  const m = new RegExp(v.regex).exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (!m) return { reason: "regex did not match the output" };
  const value = Number(m[1]);
  if (m[1] === undefined || m[1].trim() === "" || !Number.isFinite(value)) return { reason: `capture "${clean(m[1])}" is not a number` };
  return { value };
}

const table = (entries, v) => {
  const rows = entries.map((e) => `${e.attempt}\t${e.value ?? "-"}\t${e.pass ? "pass" : "fail"}${e.reason ? `\t${e.reason}` : ""}`);
  const values = entries.map((e) => e.value).filter((x) => x !== null);
  const best = values.length ? (v.op.startsWith("<") ? Math.min(...values) : Math.max(...values)) : "none";
  return ["attempt\tvalue\tresult", ...rows, `best: ${best} (need ${v.op} ${v.threshold}, attempts: ${entries.length}/${v.attempts})`].join("\n");
};

/**
 * @param {string[]} argv
 * @param {{ dir?: string, now?: () => Date, readIssue?: (n: string) => string, run?: (argv: string[]) => object }} deps
 * @returns {{ code: number, message: string }}
 */
export function main(argv, deps = {}) {
  const { dir = ".lanes", now = () => new Date(), readIssue: read = readIssue, run: exec = run } = deps;
  const usage = { code: 3, message: "usage: validate.mjs --issue N --criterion I" };
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const issue = opt("--issue");
  const index = opt("--criterion");
  if (!/^[1-9]\d*$/.test(issue ?? "") || !/^[1-9]\d*$/.test(index ?? "")) return usage;
  const cannot = (why) => ({ code: 3, message: `#${issue}: cannot validate: ${why}` });

  let criterion;
  try {
    criterion = parseIssueForm(read(issue)).fields.criteria[Number(index) - 1];
  } catch (err) {
    return cannot(`issue unreadable (${err.message})`);
  }
  if (criterion === undefined) return cannot(`no acceptance criterion ${index}`);
  let v;
  try {
    v = parseValidation(criterion);
  } catch (err) {
    return cannot(err.message);
  }
  if (!v) return cannot(`criterion ${index} is not a validate: line`);

  const file = join(dir, "validate", `${issue}.jsonl`);
  let entries;
  try {
    entries = readLog(file).filter((e) => e.criterion === Number(index));
  } catch (err) {
    return cannot(`attempt log unreadable (${err.message})`);
  }
  if (entries.length < v.attempts) {
    let result;
    try {
      result = exec(splitCommand(v.command));
    } catch (err) {
      result = { error: err };
    }
    const outcome = measure(v, result);
    const entry = {
      attempt: entries.length + 1,
      value: outcome.value ?? null,
      pass: outcome.value !== undefined && compare[v.op](outcome.value, v.threshold),
      at: now().toISOString(),
      criterion: Number(index),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    try {
      mkdirSync(join(dir, "validate"), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      return cannot(`attempt log not writable (${err.message})`);
    }
    entries.push(entry);
  }
  const last = entries[entries.length - 1];
  const code = last.pass ? 0 : entries.length >= v.attempts ? 2 : 1;
  return { code, message: table(entries, v) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  console.log(message);
  process.exitCode = code;
}
