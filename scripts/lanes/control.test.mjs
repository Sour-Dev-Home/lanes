import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { validate } from "./control.mjs";

const press = (env) => spawnSync(process.execPath, ["scripts/lanes/control.mjs"], { env: { ...process.env, LANES_ACTION: "", LANES_REASON: "", LANES_ACTOR: "", ...env }, encoding: "utf8", windowsHide: true });

test("validate accepts pause and resume with an optional reason", () => {
  assert.deepEqual(validate({ action: "pause", reason: "maintenance" }), { action: "pause", reason: "maintenance" });
  assert.deepEqual(validate({ action: "resume", reason: "" }), { action: "resume", reason: "" });
  assert.deepEqual(validate({ action: "resume" }), { action: "resume", reason: "" });
});

test("validate rejects an unknown, missing or oddly cased action", () => {
  for (const action of ["stop", "", undefined, null, "PAUSE", "pause ", "pause; rm -rf /", 1]) assert.throws(() => validate({ action, reason: "" }), /action must be pause or resume/, String(action));
});

test("edge: a reason of exactly 200 characters passes and 201 is rejected", () => {
  assert.equal(validate({ action: "pause", reason: "x".repeat(200) }).reason.length, 200);
  assert.throws(() => validate({ action: "pause", reason: "x".repeat(201) }), /201 characters, over the 200 limit/);
});

test("edge: a reason with a newline, carriage return, control, bidi or line-separator character is rejected", () => {
  for (const c of ["\n", "\r", "\t", "\u001b", "\u0000", "\u007f", "\u0085", "‮", "​", " ", " "]) assert.throws(() => validate({ action: "pause", reason: `a${c}b` }), /control character or a newline/, JSON.stringify(c));
  assert.equal(validate({ action: "pause", reason: "plain: reason, with punctuation (and é)" }).action, "pause");
});

test("the script exits 0 on a valid press and prints no secret, and exits non-zero on a bad action or reason", () => {
  const ok = press({ LANES_ACTION: "pause", LANES_REASON: "maintenance", LANES_ACTOR: "owner" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^control: pause by owner: maintenance\n$/);
  for (const env of [{ LANES_ACTION: "stop" }, { LANES_ACTION: "pause", LANES_REASON: "x".repeat(201) }, { LANES_ACTION: "pause", LANES_REASON: "a\nb" }, {}]) {
    const bad = press(env);
    assert.notEqual(bad.status, 0, JSON.stringify(env));
    assert.match(bad.stderr, /^control: /);
  }
});

test("edge: a hostile actor name is stripped in the one output line", () => {
  const r = press({ LANES_ACTION: "resume", LANES_REASON: "", LANES_ACTOR: "o\u001b[31mwner\nx" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n").length, 2);
  assert.doesNotMatch(r.stdout, /\u001b/);
});

test("control.mjs calls no API and writes nothing: no process, network or file-write use", () => {
  const src = readFileSync("scripts/lanes/control.mjs", "utf8");
  assert.doesNotMatch(src, /child_process|fetch\(|https?:|writeFile|appendFile|\bgh\b.*api/);
  assert.match(src, /from "\.\/lib\.mjs"/);
});
