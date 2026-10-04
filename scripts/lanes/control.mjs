// The pause and resume buttons (ADR 0028): run by .github/workflows/lanes-control.yml. It only validates what the button
// passed in, so an invalid press leaves a failed run that never counts. The state is the run history itself (its title
// and who started it), read by lib.mjs's readControlState; this script calls no API and writes nothing.
// Usage: LANES_ACTION=pause|resume LANES_REASON=<text> LANES_ACTOR=<login> node scripts/lanes/control.mjs
import { fileURLToPath } from "node:url";
import { CONTROL_REASON_LIMIT } from "./lib.mjs";

// Control characters, Unicode line and paragraph separators, and format characters (bidi overrides, zero-width).
const UNSAFE = /[\x00-\x1f\x7f-\x9f]|[\p{Zl}\p{Zp}]|\p{Cf}/u;

/** The action and the reason when both are valid; throws a one-line error naming what is wrong otherwise. */
export function validate({ action, reason }) {
  if (action !== "pause" && action !== "resume") throw new Error("action must be pause or resume");
  const text = reason === undefined ? "" : String(reason);
  if (text.length > CONTROL_REASON_LIMIT) throw new Error(`reason is ${text.length} characters, over the ${CONTROL_REASON_LIMIT} limit`);
  if (UNSAFE.test(text)) throw new Error("reason must not contain a control character or a newline");
  return { action, reason: text };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { action, reason } = validate({ action: process.env.LANES_ACTION, reason: process.env.LANES_REASON });
    const actor = String(process.env.LANES_ACTOR ?? "").replace(/[^A-Za-z0-9[\]-]/g, "").slice(0, 40) || "unknown";
    console.log(`control: ${action} by ${actor}${reason ? `: ${reason}` : ""}`);
  } catch (err) {
    console.error(`control: ${err.message}`);
    process.exitCode = 1;
  }
}
