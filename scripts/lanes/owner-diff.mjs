// #381, ADR 0015: decides whether a PR's owner-path diff is purely additive, so the gate may skip the /approve wait.
// Pure: it takes file contents and does no I/O. It fails closed: whatever it cannot prove additive needs the owner.

const CONFIG = "lanes.config.json";
const WORKFLOW = "scripts/lanes/workflow.test.mjs";

/** The only files `classifyOwnerDiff` can ever call additive; the same pair `gateDecision` accepts (lib.mjs). */
export const OWNER_DIFF_FILES = Object.freeze([CONFIG, WORKFLOW]);

const additive = () => ({ verdict: "additive", reason: "" });
const needsOwner = (reason) => ({ verdict: "needs-owner", reason: reason.replace(/\s+/g, " ").trim() });

/**
 * `{ verdict: "additive", reason: "" }` only when every file in `files` is one of `OWNER_DIFF_FILES`, has string
 * contents in both `base` and `head` (maps from path to file text), and its change is additive: `lanes.config.json`
 * differs only by entries appended to the end of `paths.owner`, and `workflow.test.mjs` only by whole top-level
 * `test(...)` blocks appended to its end. Anything else is `{ verdict: "needs-owner", reason }`, a one-line reason.
 */
export function classifyOwnerDiff({ files, base, head } = {}) {
  try {
    if (!Array.isArray(files) || files.length === 0) return needsOwner("no changed files to classify");
    const unexpected = files.find((file) => !OWNER_DIFF_FILES.includes(file));
    if (unexpected !== undefined) return needsOwner(`unexpected file ${JSON.stringify(String(unexpected))}`);
    for (const file of files) {
      const before = contentOf(base, file);
      const after = contentOf(head, file);
      if (before === null || after === null) return needsOwner(`${file} is missing at base or head`);
      const why = file === CONFIG ? configChange(before, after) : workflowChange(before, after);
      if (why !== null) return needsOwner(why);
    }
    return additive();
  } catch (e) {
    return needsOwner(`cannot classify: ${e?.message ?? e}`);
  }
}

const contentOf = (side, file) =>
  side !== null && typeof side === "object" && Object.hasOwn(side, file) && typeof side[file] === "string" ? side[file] : null;

// ---- lanes.config.json -------------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

/** Parses JSON text, refusing a duplicate key: JSON.parse keeps only the last, so a reader could see a different file. */
function parseJson(text, side) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG} does not parse at ${side}: ${e.message}`);
  }
  const { tokens, error } = scan(text);
  if (error) throw new Error(`${CONFIG} does not parse at ${side}: ${error}`);
  const keysInText = tokens.filter((t, i) => t.type === "string" && tokens[i + 1]?.value === ":").length;
  if (keysInText !== countKeys(value)) throw new Error(`${CONFIG} has a duplicate key at ${side}`);
  return value;
}

function countKeys(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countKeys(x), 0);
  if (!isObject(v)) return 0;
  return Object.keys(v).reduce((n, k) => n + 1 + countKeys(v[k]), 0);
}

/** A reason `after` is not `before` with keys other than `skipKey` unchanged, prefixed by `where`, or null. */
function sameKeys(before, after, where, skipKey) {
  for (const k of Object.keys(after)) if (!Object.hasOwn(before, k)) return `${CONFIG} adds ${where}key ${JSON.stringify(k)}`;
  for (const k of Object.keys(before)) {
    if (!Object.hasOwn(after, k)) return `${CONFIG} removes ${where}key ${JSON.stringify(k)}`;
    if (k !== skipKey && !jsonEqual(before[k], after[k])) return `${CONFIG} changes ${where}${k}`;
  }
  return null;
}

function configChange(beforeText, afterText) {
  let before;
  let after;
  try {
    before = parseJson(beforeText, "base");
    after = parseJson(afterText, "head");
  } catch (e) {
    return e.message;
  }
  if (!isObject(before) || !isObject(after)) return `${CONFIG} is not a JSON object`;
  const top = sameKeys(before, after, "top-level ", "paths");
  if (top) return top;
  if (!isObject(before.paths) || !isObject(after.paths)) return `${CONFIG} paths is not an object`;
  const paths = sameKeys(before.paths, after.paths, "paths.", "owner");
  if (paths) return paths;
  const was = before.paths.owner;
  const now = after.paths.owner;
  if (!Array.isArray(was) || !Array.isArray(now)) return `${CONFIG} paths.owner is not a list`;
  if (now.length <= was.length) return `${CONFIG} paths.owner appends no entry`;
  if (!was.every((entry, i) => jsonEqual(entry, now[i]))) return `${CONFIG} paths.owner removes, reorders or edits an entry`;
  for (const [offset, entry] of now.slice(was.length).entries()) {
    const index = was.length + offset;
    if (typeof entry !== "string" || entry === "") return `${CONFIG} paths.owner appends an entry that is not a pattern`;
    if (entry.length > MAX_ENTRY_LENGTH) return `${CONFIG} paths.owner entry ${index} is longer than ${MAX_ENTRY_LENGTH} characters`;
    if (QUANTIFIED_GROUP.test(entry)) return `${CONFIG} paths.owner entry ${index} holds a quantified group, which can backtrack catastrophically`;
    if (quantifierCount(entry) > MAX_QUANTIFIERS) return `${CONFIG} paths.owner entry ${index} holds more than ${MAX_QUANTIFIERS} quantifiers, which can backtrack catastrophically`;
    try {
      new RegExp(entry);
    } catch {
      return `${CONFIG} paths.owner appends an invalid pattern`;
    }
  }
  return null;
}

// #409: a pattern the gate later runs against filenames must not be able to hang it (ReDoS); `)?` stays allowed.
const MAX_ENTRY_LENGTH = 200;
const QUANTIFIED_GROUP = /\)[*+{]/;
// Group-free blowups (`a?` x28 then `a` x28, `a*a*a*a*a*a*b`) need many quantifiers; the real entries hold at most one.
// Two keeps the worst case quadratic in the filename length.
const MAX_QUANTIFIERS = 2;
const quantifierCount = (entry) => (entry.match(/[*+?{]/g) ?? []).length;

// ---- workflow.test.mjs -------------------------------------------------------------------------------------------

/**
 * A reason `after` is not `before` plus whole top-level `test("name", [async] ([param]) => { ... });` blocks at its end,
 * or null. Every added token must belong to such a block (comments and whitespace aside), so no added code runs when the
 * file is imported, before the existing tests do: a block's only import-time effect is registering its test.
 */
function workflowChange(before, after) {
  if (!after.startsWith(before)) return `${WORKFLOW} changed or removed an existing line`;
  if (before !== "" && !before.endsWith("\n")) return `${WORKFLOW} does not end with a newline at base`;
  if (before === "") return `${WORKFLOW} is empty at base`;
  const { tokens, error, topLevelAt } = scan(after, before.length);
  if (error) return `${WORKFLOW} cannot be read safely: ${error}`;
  if (!topLevelAt) return `${WORKFLOW} additions do not start at the top level`;
  // A script reads these as comments and a module does not, so the parser check below could disagree with the file.
  // JavaScript's markers are exactly "<!--" and "-->" (Annex B), so plain substring checks, not an HTML filter.
  const addedText = after.slice(before.length);
  if (addedText.includes("<!--") || addedText.includes("-->")) return `${WORKFLOW} additions hold an HTML-like comment marker`;
  const added = tokens.filter((t) => t.start >= before.length && t.type !== "comment");
  if (added.length === 0) return `${WORKFLOW} adds no test block`;
  let i = 0;
  while (i < added.length) {
    const block = testBlock(added, i);
    if (block === null) return `${WORKFLOW} adds something other than whole top-level test() blocks`;
    const why = bodyParseError(after.slice(block.bodyStart, block.bodyEnd), block);
    if (why) return `${WORKFLOW} adds a test body that does not parse on its own: ${why}`;
    i = block.end;
  }
  return null;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Security review #381, defence in depth: JavaScript's own parser must accept `body`, exactly as the tokenizer cut it,
 * as a whole strict function body on its own. The Function constructors parse the body text alone and refuse any that
 * closes the function early ("Single function literal required"), so no wrapper around it can absorb a stray `}`. If
 * that parse succeeds, JavaScript reading the file closes the body at the same `}`: only that `}`, `)`, `;`, spaces and
 * comments follow, which both read alike. The constructors only compile; nothing in the body runs. Returns the parser's
 * message, or null.
 */
function bodyParseError(body, { isAsync, param }) {
  try {
    const Ctor = isAsync ? AsyncFunction : Function;
    const strictBody = `"use strict";\n${body}`;
    if (param === null) new Ctor(strictBody);
    else new Ctor(param, strictBody);
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

const isPunct = (t, value) => t?.type === "punct" && t.value === value;
const isIdent = (t, value) => t?.type === "ident" && (value === undefined || t.value === value);

/**
 * The test block starting at `tokens[i]` as `{ end, bodyStart, bodyEnd, isAsync, param }` (`end` the token index after
 * it, the body as text offsets between its braces), or null when no whole block starts there.
 */
function testBlock(tokens, i) {
  if (!isIdent(tokens[i], "test") || !isPunct(tokens[i + 1], "(")) return null;
  const open = tokens[i + 1];
  if (tokens[i + 2]?.type !== "string" || !isPunct(tokens[i + 3], ",")) return null;
  let j = i + 4;
  const isAsync = isIdent(tokens[j], "async") && isPunct(tokens[j + 1], "(");
  if (isAsync) j++;
  if (!isPunct(tokens[j], "(")) return null;
  j++;
  let param = null;
  if (isIdent(tokens[j]) && !RESERVED.has(tokens[j].value)) param = tokens[j++].value;
  if (!isPunct(tokens[j], ")") || !isPunct(tokens[j + 1], "=>") || !isPunct(tokens[j + 2], "{")) return null;
  const body = tokens[j + 2];
  const close = tokens.indexOf(body.match, j + 2);
  if (close < 0 || tokens[close + 1] !== open.match || !isPunct(tokens[close + 2], ";")) return null;
  return { end: close + 3, bodyStart: body.end, bodyEnd: body.match.start, isAsync, param };
}

// ---- tokenizer ---------------------------------------------------------------------------------------------------

// Words after which `/` starts a regular expression rather than a division. All are reserved in a module, so none can
// be a variable. `of` is not reserved (`const of = 1` is legal), so a `/` after it is ambiguous and refused.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
// Security review #381: every reserved word is in REGEX_AFTER_WORD, in this list, or is a value word (this, super,
// true, false, null) after which `/` divides, as it does after a plain name. After any word listed here (`extends`,
// `debugger`, `of`, `get`, ...) the reading depends on grammar, so a `/` is refused.
const AMBIGUOUS_BEFORE_SLASH = new Set([
  "break", "catch", "class", "const", "continue", "debugger", "default", "enum", "export", "extends", "finally", "for",
  "function", "if", "import", "let", "static", "switch", "try", "var", "while", "with", "implements", "interface",
  "package", "private", "protected", "public", "of", "get", "set", "async", "as", "from", "target", "meta", "accessor",
]);
const RESERVED = new Set([...REGEX_AFTER_WORD, "async", "function", "class", "const", "let", "var", "this", "super", "import", "export", "if", "for", "while", "switch", "try", "catch", "finally", "with", "debugger", "default", "break", "continue", "extends", "true", "false", "null"]);
const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);
// Character codes, not escapes, so this file stays plain ASCII: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR.
const LINE_ENDS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);
const LINE_END = { test: (c) => typeof c === "string" && LINE_ENDS.has(c.charCodeAt(0)) };
// JavaScript's \s already covers the byte order mark and the Unicode spaces.
const SPACE = /\s/;
// Any non-ASCII character counts as part of a name: only brackets, quotes and slashes matter here.
const IDENT_START = { test: (c) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) >= 0x80 };
const IDENT_PART = { test: (c) => /[\w$]/.test(c) || c.charCodeAt(0) >= 0x80 };

/**
 * Splits JavaScript (or JSON) `text` into tokens `{ type, value, start, end }` (type ident, number, string, template,
 * regex, punct or comment), linking each bracket to its partner by `match`. Fails closed with `error` rather than
 * guess: an unterminated token, an unbalanced bracket, a backslash outside a literal, and a `/` after `)`, `}`, `++`
 * or `--` (where division and a regular expression cannot be told apart without a parser). `topLevelAt` says whether
 * offset `cut` falls between tokens with no bracket open.
 */
export function scan(text, cut = -1) {
  const tokens = [];
  const stack = []; // open bracket tokens; a template substitution is a token with value "${"
  let topLevelAt = false;
  let i = 0;
  const fail = (why) => ({ tokens, error: `${why} at offset ${i}`, topLevelAt: false });
  const push = (type, start, value = text.slice(start, i)) => {
    const t = { type, value, start, end: i };
    tokens.push(t);
    return t;
  };
  // The last two tokens that are not comments: `a./**/return` must still read `return` as a member name.
  const lastSignificant = () => {
    const found = [];
    for (let k = tokens.length - 1; k >= 0 && found.length < 2; k--) if (tokens[k].type !== "comment") found.push(tokens[k]);
    return { t: found[0], before: found[1] };
  };
  // Scans a template chunk from just after "`" or "}" to its closing "`" or "${".
  const templateChunk = (start) => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        push("template", start);
        return null;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        const t = push("template", start);
        t.value = "${";
        stack.push(t);
        return null;
      } else i++;
    }
    return "unterminated template";
  };

  if (text.startsWith("#!")) {
    while (i < text.length && !LINE_END.test(text[i])) i++;
    push("comment", 0);
  }
  while (i < text.length) {
    if (i === cut) topLevelAt = stack.length === 0;
    const c = text[i];
    const start = i;
    if (SPACE.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && !LINE_END.test(text[i])) i++;
      push("comment", start);
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return fail("unterminated comment");
      i = end + 2;
      push("comment", start);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\n" || text[i] === "\r") return fail("unterminated string");
        if (text[i] === "\\") i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 2;
        else i++;
      }
      if (i >= text.length) return fail("unterminated string");
      i++;
      push("string", start);
    } else if (c === "`") {
      i++;
      const why = templateChunk(start);
      if (why) return fail(why);
    } else if (c === "/") {
      const { t, before } = lastSignificant();
      // A word after ".", "?." or "#" is a property or private name, never a keyword.
      const isName = isPunct(before, ".") || isPunct(before, "?.") || isPunct(before, "#");
      const afterWord = t?.type === "ident" && REGEX_AFTER_WORD.has(t.value) && !isName;
      if (t && (isPunct(t, ")") || isPunct(t, "}") || isPunct(t, "++") || isPunct(t, "--"))) return fail("ambiguous '/'");
      if (t?.type === "ident" && AMBIGUOUS_BEFORE_SLASH.has(t.value) && !isName) return fail("ambiguous '/'");
      // After a value (a name, literal or closed "]") it divides; after an operator, "${" or nothing it starts a regex.
      const division =
        isPunct(t, "]") ||
        (t?.type === "ident" && !afterWord) ||
        ["number", "string", "regex"].includes(t?.type) ||
        (t?.type === "template" && t.value !== "${");
      if (division) {
        i += text[i + 1] === "=" ? 2 : 1;
        push("punct", start);
      } else {
        i++;
        let inClass = false;
        for (;;) {
          if (i >= text.length || LINE_END.test(text[i])) return fail("unterminated regular expression");
          const r = text[i];
          if (r === "\\") i += 2;
          else {
            i++;
            if (r === "[") inClass = true;
            else if (r === "]") inClass = false;
            else if (r === "/" && !inClass) break;
          }
        }
        while (i < text.length && IDENT_PART.test(text[i])) i++;
        push("regex", start);
      }
    } else if (IDENT_START.test(c)) {
      while (i < text.length && IDENT_PART.test(text[i])) i++;
      push("ident", start);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      // Only a decimal literal has a signed exponent: `0x1e+1` is 0x1e plus 1 (security review #381).
      const decimal = !/^0[xXoObB]/.test(text.slice(start, start + 2));
      const sign = (k) => decimal && (text[k] === "+" || text[k] === "-") && /[eE]/.test(text[k - 1]);
      while (i < text.length && (IDENT_PART.test(text[i]) || text[i] === "." || sign(i))) i++;
      push("number", start);
    } else if (c === "\\") {
      return fail("backslash outside a literal");
    } else if (OPEN[c]) {
      i++;
      stack.push(push("punct", start));
    } else if (CLOSE.has(c)) {
      const open = stack.pop();
      if (open?.value === "${" && c === "}") {
        const why = templateChunk(start);
        if (why) return fail(why);
        continue;
      }
      if (!open || OPEN[open.value] !== c) return fail(`unbalanced '${c}'`);
      i++;
      const t = push("punct", start);
      open.match = t;
      t.match = open;
    } else {
      const two = text.slice(i, i + 2);
      i += ["=>", "++", "--", "?."].includes(two) ? 2 : 1;
      push("punct", start);
    }
  }
  if (cut === text.length) topLevelAt = stack.length === 0;
  if (stack.length > 0) return fail(`unclosed '${stack.at(-1).value}'`);
  return { tokens, error: null, topLevelAt };
}
