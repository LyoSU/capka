#!/usr/bin/env node
/**
 * An `mmdc`-shaped mermaid renderer for the sandbox image.
 *
 * Why this exists instead of @mermaid-js/mermaid-cli: that package weighed 462 MB
 * installed — react-aria, fontawesome, zenuml, napi-rs and the rest of the mermaid
 * ecosystem's dependency graph — to wrap `dist/mermaid.min.js`, which is 3.5 MB. The
 * image already ships the browser needed to run it, so the wrapper was the only part
 * we were paying for. This covers the ordinary case (one diagram file in, one image
 * file out) and says so plainly when asked for anything else, rather than silently
 * rendering something other than what was requested.
 *
 * CommonJS on purpose: the global npm tree is reachable through NODE_PATH, which
 * Node honours for `require` and NOT for ESM `import`.
 */
const fs = require("fs");
const path = require("path");

const MERMAID_JS = "/opt/mermaid/mermaid.min.js";
const SUPPORTED = "-i/--input, -o/--output, -t/--theme, -b/--backgroundColor, -w/--width, -H/--height, -s/--scale";

function die(msg, code = 2) {
  console.error(`mmdc: ${msg}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const opt = { theme: "default", background: "white", width: 1200, height: 800, scale: 1 };
let input = null;
let output = null;

for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined) die(`${flag} needs a value`);
    return v;
  };
  switch (flag) {
    case "-i": case "--input": input = value(); break;
    case "-o": case "--output": output = value(); break;
    case "-t": case "--theme": opt.theme = value(); break;
    case "-b": case "--backgroundColor": opt.background = value(); break;
    case "-w": case "--width": opt.width = parseInt(value(), 10); break;
    case "-H": case "--height": opt.height = parseInt(value(), 10); break;
    case "-s": case "--scale": opt.scale = parseFloat(value()); break;
    case "-h": case "--help":
      console.log(`usage: mmdc -i <diagram.mmd> -o <out.svg|out.png|out.pdf> [flags]\nflags: ${SUPPORTED}`);
      process.exit(0);
      break;
    default:
      // Failing loudly beats ignoring the flag: a silently dropped -c/--configFile
      // or -p/--puppeteerConfigFile would produce a diagram that is not the one
      // asked for, and look like success.
      die(`unsupported flag "${flag}". This image ships a small renderer, not upstream mermaid-cli.\n       supported: ${SUPPORTED}`);
  }
}

(async () => {
  if (!input || !output) die("both -i <input> and -o <output> are required");
  if (!fs.existsSync(MERMAID_JS)) die(`${MERMAID_JS} is missing — the image was built without the mermaid bundle`, 1);
  const definition = fs.readFileSync(input, "utf8");
  const ext = path.extname(output).toLowerCase();
  if (![".svg", ".png", ".pdf"].includes(ext)) die(`unsupported output type "${ext}" — use .svg, .png or .pdf`);

  const { chromium } = require("playwright");
  // Explicit flags: playwright launches the real binary in /opt/pw-browsers, so it
  // does not pass through the /usr/local/bin/chromium wrapper that carries them.
  // Without --no-sandbox Chrome cannot start at all under the container's dropped
  // capabilities ("No usable sandbox!").
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const transparent = opt.background === "transparent";
    const page = await browser.newPage({
      viewport: { width: opt.width, height: opt.height },
      deviceScaleFactor: opt.scale,
    });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
      `<body style="margin:0;background:${transparent ? "none" : opt.background}">` +
      `<div id="container"></div></body>`,
    );
    await page.addScriptTag({ path: MERMAID_JS });

    const svg = await page.evaluate(async ({ definition, theme }) => {
      // securityLevel strict is mermaid's own sanitiser, and it is set explicitly
      // because a diagram definition is not always something the agent wrote — it
      // may have been lifted out of a document the user uploaded. The page itself is
      // a throwaway about:blank with no origin, cookies or storage, so the SVG below
      // is inserted as markup deliberately; there is nothing here for a script to
      // reach that the agent's own uid does not already have.
      window.mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
      const { svg } = await window.mermaid.render("diagram", definition);
      document.getElementById("container").innerHTML = svg;
      return svg;
    }, { definition, theme: opt.theme });

    if (ext === ".svg") {
      fs.writeFileSync(output, svg);
    } else if (ext === ".png") {
      const el = await page.$("#container svg");
      await el.screenshot({ path: output, omitBackground: transparent });
    } else {
      // Size the page to the diagram so the PDF is one tight page rather than A4
      // with the drawing stranded in a corner.
      const box = await (await page.$("#container svg")).boundingBox();
      await page.pdf({
        path: output,
        printBackground: !transparent,
        width: `${Math.ceil(box.width)}px`,
        height: `${Math.ceil(box.height)}px`,
        pageRanges: "1",
      });
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(`mmdc: ${(err && err.message) || err}`);
  process.exit(1);
});
