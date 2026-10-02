// scripts/lanes/shell-lex.fixtures.mjs — test fixtures start-guard.test.mjs and shell-lex.test.mjs share (#351).
import { test } from "node:test";
import assert from "node:assert/strict";

// The automated-input wrappers a guard's UserPromptSubmit hook ignores (#262), as the tests expect them.
export const WRAPPERS = ["<task-notification>", "Another Claude session sent a message:", "<cross-session-message", "[Cross-session idle notice]"];

/** Registers the "#262 criterion 1" test against a guard's onUserPromptSubmit, at time `now`. */
export function automatedInputLeavesTheGrant(onUserPromptSubmit, now) {
  test("#262 criterion 1: a prompt that starts with an automated-input wrapper leaves the grant alone", () => {
    for (const w of WRAPPERS) {
      for (const p of [w, `${w}\nreviewer done`, `  \n\t${w} from="peer">hi</cross-session-message>`]) {
        assert.deepEqual(onUserPromptSubmit({ session_id: "s1", prompt: p }, now), { action: "none" }, JSON.stringify(p));
      }
    }
  });
}
