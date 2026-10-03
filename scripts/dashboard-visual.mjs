// scripts/dashboard-visual.mjs
// Renders dashboard/ in a real browser at phone, tablet and desktop widths in light and dark, writes one PNG per case
// and counts layout defects (ADR 0014). Opt-in and local: no workflow runs it.
//
//   node scripts/dashboard-visual.mjs [--fixture <file>] [--out <dir>] [--count]
//
// Exit 0: no defects. 1: defects. 2: Playwright or its browser could not start. With --count, exit 0 whenever it could
// measure, so a `validate:` loop reads the number from the last line (`defects: <N>`).
//
// Playwright runs through `npx --yes` with npm install scripts turned off, as structure-report.mjs runs jscpd: the
// launcher re-runs this file under `npx -p <PLAYWRIGHT_PACKAGE>` and the child finds the package on the PATH npx sets.
// The parsing, the case list and the defect classifier are pure and tested without a browser.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned: npx --yes installs whatever it is told without asking, so the version is fixed here, not left to "latest".
export const PLAYWRIGHT_PACKAGE = "playwright@1.63.0";
export const DEFAULT_FIXTURE = "contracts/dashboard-visual.fixture.json";
export const DEFAULT_OUT = ".lanes/visual";
const WIDTHS = [375, 768, 1280];
const SCHEMES = ["light", "dark"];
const HEIGHT = 900;
const TOLERANCE = 1; // px of rounding slack
const CHILD_ENV = "LANES_DASHBOARD_VISUAL_CHILD";
// Every path argument ends up in one npx command line on Windows, so anything a shell could act on is refused.
const SAFE_ARG = /^[\w./\\:@+-][\w ./\\:@+-]*$/;

// The dashboard's required fields: an issue number, a title and a stage, on task rows and on waiting cards.
export const REQUIRED_SELECTORS = ["#tasks li.task .num", "#tasks li.task .title", "#tasks li.task .chip", "#waiting .card .num", "#waiting .card .title"];

/** `--fixture <file>`, `--out <dir>`, `--count`; throws on anything else. */
export function parseArgs(argv) {
  const options = { fixture: DEFAULT_FIXTURE, out: DEFAULT_OUT, count: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") options.count = true;
    else if (a === "--fixture" || a === "--out") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      if (!SAFE_ARG.test(v)) throw new Error(`unsafe characters in the ${a} value`);
      options[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

/** The six cases, width-major: each width in light then dark. */
export function buildCases() {
  return WIDTHS.flatMap((width) => SCHEMES.map((scheme) => ({ name: `${width}-${scheme}`, width, scheme })));
}

const clipsOverflow = (v) => v === "hidden" || v === "clip";
const overlap = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE;

/**
 * Defects of one case from measured boxes. An element is { id, selector, ancestors (ids), visible, hasText, inScroller,
 * overflowX, overflowY, scrollWidth, clientWidth, scrollHeight, clientHeight, rect }; `required` is [{ selector, text }].
 * Returns [{ case, selector, kind }].
 */
export function classify({ name, viewportWidth, elements, required }) {
  const defects = [];
  const add = (selector, kind) => defects.push({ case: name, selector, kind });
  const shown = elements.filter((e) => e.visible);
  for (const e of shown) {
    if (!e.hasText || e.clientWidth <= 0) continue;
    const clippedX = clipsOverflow(e.overflowX) && e.scrollWidth - e.clientWidth > TOLERANCE;
    const clippedY = clipsOverflow(e.overflowY) && e.clientHeight > 0 && e.scrollHeight - e.clientHeight > TOLERANCE;
    if (clippedX || clippedY) add(e.selector, "text-clipped");
  }
  const texts = shown.filter((e) => e.hasText);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.ancestors.includes(b.id) || b.ancestors.includes(a.id)) continue;
      if (overlap(a.rect, b.rect)) add(`${a.selector} / ${b.selector}`, "text-overlap");
    }
  }
  for (const e of shown) {
    if (e.inScroller) continue;
    if (e.rect.right > viewportWidth + TOLERANCE || e.rect.left < -TOLERANCE) add(e.selector, "outside-viewport");
  }
  for (const r of required) if (!String(r.text).trim()) add(r.selector, "required-empty");
  return defects;
}

/** Output lines: each defect as `<case> <selector>: <kind>`, then `defects: <N>`. */
export function formatReport(defects) {
  return [...defects.map((d) => `${d.case} ${d.selector}: ${d.kind}`), `defects: ${defects.length}`];
}

export function exitCode(defectCount, count) {
  return count || defectCount === 0 ? 0 : 1;
}

// In the page: measures every element under body. Runs in the browser, so it uses only its arguments.
function measureInPage(requiredSelectors) {
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent && parent !== document.body) {
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
      let up = parent.id ? `#${parent.id}` : parent.tagName.toLowerCase();
      const grand = parent.parentElement;
      if (!parent.id && grand) {
        const kin = Array.from(grand.children).filter((c) => c.tagName === parent.tagName);
        if (kin.length > 1) up += `:nth-of-type(${kin.indexOf(parent) + 1})`;
        if (grand.id) up = `#${grand.id} > ${up}`;
      }
      s = `${up} > ${s}`;
    }
    return s;
  };
  const all = Array.from(document.body.querySelectorAll("*"));
  const ids = new Map(all.map((el, i) => [el, i]));
  const elements = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    const ancestors = [];
    let inScroller = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      ancestors.push(ids.get(p));
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") inScroller = true;
    }
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
    elements.push({
      id: ids.get(el), selector: describe(el), ancestors, visible, hasText, inScroller, overflowX: cs.overflowX, overflowY: cs.overflowY,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    });
  }
  const required = [];
  for (const sel of requiredSelectors) {
    const found = document.querySelectorAll(sel);
    for (const el of found) required.push({ selector: sel, text: el.textContent || "" });
    // A task row is always present in the fixture, so a selector with no match is a field that was dropped.
    if (!found.length && sel.startsWith("#tasks")) required.push({ selector: sel, text: "" });
  }
  return { elements, required };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

/** Serves dashboard/ on a free localhost port, with `snapshotText` as snapshot.json. Resolves { url, close }. */
function serve(dashboardDir, snapshotText) {
  const root = resolve(dashboardDir);
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/snapshot.json") {
      res.writeHead(200, { "content-type": TYPES[".json"] });
      return res.end(snapshotText);
    }
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + "/") && !file.startsWith(root + "\\")) return (res.writeHead(403), res.end());
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

// The playwright package npx put on PATH: `.bin/playwright` sits beside the package's node_modules siblings.
function loadPlaywright() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!/node_modules[\\/]\.bin$/.test(dir)) continue;
    const modules = dirname(dir);
    const manifest = join(modules, "playwright", "package.json");
    if (!existsSync(manifest)) continue;
    // A repo-local playwright of another version must not stand in for the pinned one.
    if (JSON.parse(readFileSync(manifest, "utf8")).version !== PLAYWRIGHT_PACKAGE.split("@")[1]) continue;
    return createRequire(join(modules, "x.js"))("playwright");
  }
  throw new Error(`${PLAYWRIGHT_PACKAGE} is not on the PATH npx set up`);
}

async function measure(options) {
  let snapshotText;
  try {
    snapshotText = readFileSync(options.fixture, "utf8");
    JSON.parse(snapshotText);
  } catch (err) {
    console.error(`cannot read fixture ${options.fixture}: ${err.message}`);
    return 2;
  }
  let browser;
  let server;
  try {
    const { chromium } = loadPlaywright();
    browser = await chromium.launch();
    server = await serve("dashboard", snapshotText);
    mkdirSync(options.out, { recursive: true });
    const defects = [];
    for (const c of buildCases()) {
      const context = await browser.newContext({ viewport: { width: c.width, height: HEIGHT }, colorScheme: c.scheme });
      const page = await context.newPage();
      await page.goto(server.url, { waitUntil: "load" });
      await page.waitForFunction(() => !/^Loading/.test(document.getElementById("generated")?.textContent || "Loading"), null, { timeout: 10000 });
      const data = await page.evaluate(measureInPage, REQUIRED_SELECTORS);
      await page.screenshot({ path: join(options.out, `${c.name}.png`), fullPage: true });
      await context.close();
      defects.push(...classify({ name: c.name, viewportWidth: c.width, ...data }));
    }
    for (const line of formatReport(defects)) console.log(line);
    return exitCode(defects.length, options.count);
  } catch (err) {
    console.error(`cannot measure: ${String(err.message).split("\n")[0]}`);
    console.error(`If the browser is missing, install it once with: npx --yes ${PLAYWRIGHT_PACKAGE} install chromium`);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
}

// Re-runs this file under npx with the pinned package and npm install scripts off; the child's exit code is ours.
function launch(argv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "npm_config_ignore_scripts"));
  env.npm_config_ignore_scripts = "true";
  env[CHILD_ENV] = "1";
  const file = fileURLToPath(import.meta.url);
  if (process.platform === "win32" && !SAFE_ARG.test(file)) {
    console.error("cannot start: the script path has characters a Windows shell could expand");
    return 2;
  }
  const args = ["--yes", "-p", PLAYWRIGHT_PACKAGE, "node", file, ...argv];
  // npx is a .cmd shim on Windows, which spawn cannot start without a shell. Every argument passed the SAFE_ARG check.
  const r =
    process.platform === "win32"
      ? spawnSync(`npx ${args.map((a) => `"${a}"`).join(" ")}`, [], { env, stdio: "inherit", shell: true, windowsHide: true })
      : spawnSync("npx", args, { env, stdio: "inherit", windowsHide: true });
  if (r.error) console.error(`cannot start npx: ${r.error.message}`);
  return r.status === 0 || r.status === 1 || r.status === 2 ? r.status : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  process.exit(process.env[CHILD_ENV] ? await measure(options) : launch(process.argv.slice(2)));
}
