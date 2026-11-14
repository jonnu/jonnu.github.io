// Builds the downloadable resume PDF.
//
//   node build.mjs <resume.json> <output.pdf>
//
// 1. Copies the JSON Resume data, keeping only the sections shown on /resume/
//    and turning Markdown links into plain text (the theme prints them raw).
// 2. Renders it to HTML with the Colophon theme.
// 3. Swaps the theme's fonts for Merriweather, loaded from Google Fonts.
// 4. Prints the HTML to PDF with headless Chrome (set CHROME_PATH to override
//    the browser; set CHROME_NO_SANDBOX=1 on CI runners that need it).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render } from "resumed";
import * as theme from "jsonresume-theme-colophon";

const here = dirname(fileURLToPath(import.meta.url));

// Sections rendered on content/resume/_index.md. Keep in sync with that page.
const SECTIONS = ["basics", "work", "skills", "education", "volunteer"];

function stripMarkdownLinks(value) {
  if (typeof value === "string") return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  if (Array.isArray(value)) return value.map(stripMarkdownLinks);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripMarkdownLinks(v)]));
  }
  return value;
}

function prepare(resume) {
  const out = {};
  for (const key of SECTIONS) if (resume[key] !== undefined) out[key] = resume[key];
  return stripMarkdownLinks(out);
}

// Merriweather from Google Fonts. display=block so Chrome waits for it before printing.
const FONT_CSS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&display=block">
<style>:root { --font-serif: "Merriweather", Georgia, serif; --font-body: "Merriweather", Georgia, serif; }</style>`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Chrome not found. Set CHROME_PATH. Tried: ${candidates.join(", ")}`);
  return found;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node build.mjs <resume.json> <output.pdf>");
    process.exit(2);
  }

  const resume = prepare(JSON.parse(readFileSync(input, "utf8")));
  let html = await render(resume, theme);
  if (!html.includes("</head>")) throw new Error("Theme output has no </head> to inject fonts into");
  html = html.replace("</head>", `${FONT_CSS}\n</head>`);

  const work = mkdtempSync(join(tmpdir(), "resume-pdf-"));
  try {
    const htmlPath = join(work, "resume.html");
    writeFileSync(htmlPath, html);
    const pdfPath = resolve(output);
    mkdirSync(dirname(pdfPath), { recursive: true });

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--virtual-time-budget=5000",
      `--print-to-pdf=${pdfPath}`,
    ];
    if (process.env.CHROME_NO_SANDBOX === "1") args.push("--no-sandbox");
    args.push(pathToFileURL(htmlPath).href);
    execFileSync(findChrome(), args, { stdio: ["ignore", "ignore", "pipe"] });

    if (!existsSync(pdfPath) || statSync(pdfPath).size < 10_000) {
      throw new Error(`PDF missing or suspiciously small: ${pdfPath}`);
    }
    // Fail rather than publish a PDF in a fallback font if Google Fonts didn't load.
    if (!readFileSync(pdfPath).includes("Merriweather")) {
      throw new Error("Merriweather was not embedded in the PDF (Google Fonts unreachable?)");
    }
    console.log(`Wrote ${pdfPath} (${Math.round(statSync(pdfPath).size / 1024)} KB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
