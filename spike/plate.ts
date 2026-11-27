// Poster spike (Nov 27): can Specs make a printed-looking poster like Scott's image-model Holiday
// Listening Party poster while every word, font, color and the logo stay exact? One brief, one
// brand (Good Company Records & CDs), three builds, judged blind beside today's Specs post and
// Scott's target:
//
//   A. HTML only, with references and print textures: prompts/compose-bold.md + print-kit.md.
//   B. Painted plate, real type on top (the option Scott chose):
//      1. Claude lays out the type layer (compose-bold + print-kit + plate-type) and says where
//         the art goes ("art zones").
//      2. Code measures where each slot sits and tells the painter in words (shown a gray
//         wireframe, run 1's painter copied the blocks as patches; the wireframe is now only
//         on the review page).
//      3. The image model (Gemini, OpenAI or both: --image) paints a text-free plate around
//         those areas from the references (prompts/plate.md), PLATE_TAKES times each.
//      4. Code puts the plate under the type layer; Claude sees the result and fits the layer to
//         the plate once (same prompt, the render attached).
//   C. The image model paints the whole poster, words and logo included (prompts/poster-full.md).
//      Nothing enforces its words, so Claude reads them back (prompts/read-back.md) and code
//      lists every invented or missing word.
//
// Every candidate's words are read back from the render, so A and B are checked from pixels too.
// Writes output/plate-<run-id>/index.html and a sheet PNG.
//
// Usage: npm run spike -- spike/plate.ts [--image gemini|openai|both] [--takes N] [--skip-c]
// Needs ANTHROPIC_API_KEY, plus GEMINI_API_KEY and/or OPENAI_API_KEY, in .env. None is logged.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import YAML from "yaml";
import { z } from "zod";
import { STEPS, SKETCH } from "../core/config.ts";
import { ComposeSchema, buildComposedPage, LAYOUT_PROBE, TEXT_SLOTS, type Composition, type ProbeIssue, type TextSlot } from "../core/compose.ts";
import { brandDir, kitDir, OUTPUT_DIR, ROOT } from "./lib/paths.ts";
import { loadChunks, formatChunks, wordmarkLines } from "./lib/kit.ts";
import { loadPrompt } from "./lib/prompts.ts";
import { callStructured, type Image, type Usage } from "./lib/claude.ts";
import { ArtCritiqueSchema, checkBold, fillEchoes, relevantIssues, type ArtCritique } from "../core/bold.ts";
import { paintSketch, SKETCH_WORST_USD } from "../core/sketch.ts";
import { paintOpenAI, OPENAI_WORST_USD } from "../core/image-openai.ts";
import { PRINT_TEXTURE_CSS, WIREFRAME_CSS, withPlate } from "../core/print.ts";
import { PosterReadSchema, judgePoster, type PosterVerdict } from "../core/poster.ts";

const BRAND = "good-company";
const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes("=") ? args[i]!.split("=")[1] : args[i + 1];
};
type Painter = "gemini" | "openai";
const imageArg = argOf("--image") ?? "gemini";
if (!["gemini", "openai", "both"].includes(imageArg)) throw new Error("--image must be gemini, openai or both");
const painters: Painter[] = imageArg === "both" ? ["gemini", "openai"] : [imageArg as Painter];
const PLATE_TAKES = Number(argOf("--takes") ?? (painters.length > 1 ? 1 : 2));
const skipC = args.includes("--skip-c");
const skipA = args.includes("--skip-a");
const C_TAKES = Number(argOf("--c-takes") ?? 1);
// --reuse output/plate-<run-id>: take images an earlier run already painted (same file names) instead of paying for them again.
const REUSE = argOf("--reuse");
if (REUSE && !existsSync(join(REUSE, "posts"))) throw new Error(`--reuse: no posts/ folder in ${REUSE}`);
const keys: Record<Painter, string | undefined> = { gemini: process.env.GEMINI_API_KEY, openai: process.env.OPENAI_API_KEY };
for (const p of painters) if (!keys[p]) throw new Error(`${p === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} is missing from .env.`);

// The brief, the photo, the logo and the references.
type Ref = { file: string; borrow: string; ignore?: string };
type Poster = { id: string; direction?: string; intent: string; goal: string; aspect: "1:1" | "4:5"; season?: string; photo: string; reads_as?: string; slots: Partial<Record<TextSlot, string>>; references: Ref[] };
const poster = YAML.parse(readFileSync(join(brandDir(BRAND), "poster.yaml"), "utf8")) as Poster;
const refs = poster.references ?? [];
if (!refs.length) throw new Error("Add Scott's reference posters to brands/good-company/poster.yaml (references:) first.");
const photoAbs = join(brandDir(BRAND), poster.photo);
const logoAbs = join(brandDir(BRAND), "logo.png");
for (const f of [photoAbs, logoAbs, ...refs.map((r) => join(brandDir(BRAND), r.file))]) if (!existsSync(f)) throw new Error(`Missing ${relative(ROOT, f)}`);
const blank = Object.fromEntries(TEXT_SLOTS.map((k) => [k, null])) as Record<TextSlot, string | null>;
const slots = { ...blank, ...poster.slots } as Record<TextSlot, string | null>;
const H = poster.aspect === "4:5" ? 1350 : 1080;

const runId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
const runDir = join(OUTPUT_DIR, `plate-${runId}`);
mkdirSync(join(runDir, "posts"), { recursive: true });
const rel = (abs: string) => relative(join(runDir, "posts"), abs).split("\\").join("/");
const fontsHref = rel(join(brandDir(BRAND), "fonts", "fonts.css"));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const usage: Usage[] = [];
const imageCalls: { what: string; model: string; usd: number; seconds: number }[] = [];
const timing: Record<string, number> = {};

const chunks = loadChunks(BRAND);
const pick = (ids: string[]) => formatChunks(ids.filter((id) => chunks.has(id)).map((id) => chunks.get(id)!));
const designKit = pick(["energy", "references", "layout-system", "visual-system", "art-direction", "social-rules"]);
const lookKit = pick(["energy", "references", "visual-system", "art-direction"]);
const fullKit = pick(["positioning-core", "energy", "references", "layout-system", "visual-system", "art-direction", "social-rules", "guardrails"]);
const tokensCss = readFileSync(join(kitDir(BRAND), "tokens.css"), "utf8") + "\n" + PRINT_TEXTURE_CSS;
const tokensForPrompt = readFileSync(join(kitDir(BRAND), "tokens.css"), "utf8") + "\n/* Print textures, set by code (images; reference them only as background-image or mask-image): --paper-grain, --ink-speckle, --paper-mottle, --ink-wear */";
const briefs = YAML.parse(readFileSync(join(brandDir(BRAND), "briefs.yaml"), "utf8")) as { business_name: string; photos?: { file: string; alt: string }[] };
const lockup = wordmarkLines(BRAND);
const alt = briefs.photos?.find((x) => x.file === poster.photo)?.alt.trim() ?? "The owner's photo of the shop.";
const canvas = `${poster.aspect === "4:5" ? "1080 × 1350 px (4:5)" : "1080 × 1080 px (1:1)"}, a square poster for Instagram and print. The brand's safe margin is var(--safe-margin).`;
const copyText = TEXT_SLOTS.filter((s) => slots[s]).map((s) => `${s}: "${slots[s]}" (${slots[s]!.length} characters)`).join("\n");
const copy = copyText + (poster.reads_as ? `\nReads as: "${poster.reads_as}"` : "") + (poster.season ? `\nSeason: ${poster.season}` : "");
const refList = refs.map((r, i) => `Reference ${i + 1} (image ${i + 3}): borrow ${r.borrow}${r.ignore ? `; ignore ${r.ignore}` : ""}`).join("\n");

// Images for Claude: every one shrunk to a JPEG under the size limit, labeled so they can't be mixed up.
async function small(abs: string, max = 1400): Promise<string> {
  const page = await browser.newPage({ viewport: { width: max, height: max } });
  const mime = extname(abs).toLowerCase() === ".png" ? "image/png" : extname(abs).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg";
  await page.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:${mime};base64,${readFileSync(abs).toString("base64")}" style="max-width:${max}px;max-height:${max}px;display:block">`);
  const box = await page.locator("#i").boundingBox();
  const buf = await page.locator("#i").screenshot({ type: "jpeg", quality: 86 });
  await page.close();
  if (!box) throw new Error(`Couldn't read ${abs}`);
  return buf.toString("base64");
}
const jpeg = (base64: string, label: string): Image => ({ mediaType: "image/jpeg", base64, label });
const photoImg = jpeg(await small(photoAbs), "Image 1: the owner's photo (placed by code in the photo slot).");
const logoImg: Image = { mediaType: "image/png", base64: readFileSync(logoAbs).toString("base64"), label: "Image 2: the brand's real logo (placed by code in the wordmark slot)." };
const refImgs: Image[] = [];
for (const [i, r] of refs.entries()) refImgs.push(jpeg(await small(join(brandDir(BRAND), r.file)), `Image ${i + 3}: reference poster ${i + 1}. ${r.borrow}`));
const photoLine = `Image 1. ${alt}`;
const logoLine = "Image 2: the brand's real logo (PNG), placed by code in the wordmark slot. Plum on cream: never put it on a dark ground.";

type Built = { label: string; name: string; png: string | null; composition?: Composition | null; errors: string[]; probe: ProbeIssue[]; tries: number; plate?: string; readBack?: ReadCheck; usd?: number; seconds?: number };
const issueText = (b: { errors: string[]; probe: ProbeIssue[] }) => [...b.errors, ...b.probe.map((i) => `${i.slot}: ${i.problem}`)];

async function shoot(htmlFile: string, pngFile: string): Promise<ProbeIssue[]> {
  const page = await browser.newPage({ viewport: { width: 1080, height: H }, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const issues = (await page.evaluate(LAYOUT_PROBE)) as ProbeIssue[];
    await page.locator(".post").screenshot({ path: pngFile });
    return issues;
  } finally {
    await page.close();
  }
}

function pageHtml(c: Pick<Composition, "html" | "css">, usesPhoto: boolean): string {
  return buildComposedPage({
    composition: { html: fillEchoes(c.html, slots), css: c.css },
    slots,
    aspect: poster.aspect,
    tokensCss,
    fontsHref,
    wordmarkLines: lockup,
    logoSrc: rel(logoAbs),
    photo: usesPhoto ? { src: rel(photoAbs), alt } : null,
  });
}

/** Renders a composition, optionally over a plate; returns the PNG path (run-relative) and probe issues. */
async function render(c: Pick<Composition, "html" | "css">, name: string, opts: { plate?: string; wireframe?: boolean } = {}): Promise<{ png: string; probe: ProbeIssue[] }> {
  const usesPhoto = /data-slot=["']?photo/.test(c.html);
  let html = pageHtml(c, usesPhoto);
  if (opts.plate) html = withPlate(html, rel(join(runDir, opts.plate)));
  if (opts.wireframe) html = html.replace("</head>", `<style>${WIREFRAME_CSS}</style></head>`);
  const file = join(runDir, "posts", `${name}.html`);
  writeFileSync(file, html);
  let probe = relevantIssues(await shoot(file, file.replace(/\.html$/, ".png")), true);
  if (!opts.wireframe) {
    const share = await logoShare(file);
    if (share < 0.2) probe.push({ slot: "wordmark", code: "small_type", problem: `the logo is ${Math.round(share * 100)}% of the canvas width; make it at least 20% (about 220px wide)` });
  }
  // Over a painted plate the probe can't see the real ground (it reads CSS colors, not pixels),
  // so contrast and "on the photo" are checked by reading the render back instead.
  if (opts.plate) probe = probe.filter((i) => i.code !== "contrast" && i.code !== "on_photo");
  return { png: `posts/${name}.png`, probe };
}

/** How much of the canvas width the logo image takes. */
async function logoShare(htmlFile: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: 1080, height: H } });
  try {
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
    return (await page.evaluate(`(() => { const P = document.querySelector('.post').getBoundingClientRect(); const l = document.querySelector('[data-slot="wordmark"] img') || document.querySelector('[data-slot="wordmark"]'); return l ? l.getBoundingClientRect().width / P.width : 0; })()`)) as number;
  } finally {
    await page.close();
  }
}

/** One compose call plus the code checks, up to two tries. */
async function compose(o: { label: string; name: string; appendix: string; images: Image[]; plate?: string; fitNotes?: string; from?: Built }): Promise<Built> {
  let b: Built = o.from ? { ...o.from, label: o.label, name: o.name, tries: 0 } : { label: o.label, name: o.name, png: null, composition: null, errors: [], probe: [], tries: 0, plate: o.plate };
  for (let n = 1; n <= 2; n++) {
    const sentBack = b.composition && (n > 1 || o.fitNotes)
      ? `<previous_attempt_sent_back>\nYour previous HTML:\n${b.composition.html}\n\nYour previous CSS:\n${b.composition.css}\n\n${n === 1 && o.fitNotes ? o.fitNotes : `Problems found by code:\n${issueText(b).map((e) => `- ${e}`).join("\n")}`}\n</previous_attempt_sent_back>`
      : "";
    const p = loadPrompt("compose-bold", {
      kit: designKit,
      tokens: tokensForPrompt,
      business_name: briefs.business_name,
      intent: poster.intent,
      goal: poster.goal,
      direction: `${poster.direction ?? "A printed event poster in this brand's voice, as strong as the reference posters."}\n\n<references>\n${refList}\n</references>`,
      canvas,
      copy,
      photo: photoLine,
      logo: logoLine,
      feedback: sentBack,
    });
    const out = await callStructured({ step: "compose_print", system: `${p.system}\n\n${o.appendix}`, user: p.user, images: o.images, schema: ComposeSchema });
    usage.push(out.usage);
    const usesPhoto = /data-slot=["']?photo/.test(out.data.html);
    // B must use the owner photo (run 2 type layer dropped it and nothing noticed).
    const check = checkBold(out.data, slots, o.label.startsWith("B") ? true : usesPhoto);
    b = { ...b, composition: out.data, errors: check.errors, probe: [], tries: n };
    if (!check.ok) continue;
    const r = await render(out.data, `${o.label.toLowerCase().replace(/\W+/g, "-")}-${n}`, { plate: o.plate });
    b.png = r.png;
    b.probe = r.probe;
    if (!r.probe.length) break;
  }
  return b;
}

// Reading every word back from a render: the shared check in core/poster.ts.
type ReadCheck = PosterVerdict & { logoNotes: string; raw: string[] };
async function readBack(pngAbs: string, withPhoto = false): Promise<ReadCheck> {
  const p = loadPrompt("read-back", { copy: copyText, photo_line: withPhoto ? "The owner's photo is the third." : "No owner photo is given.", logo_line: "No logo spot: the logo is painted." });
  const images = [jpeg(await small(pngAbs, 1200), "Image 1: the poster."), { ...logoImg, label: "Image 2: the brand's real logo." }, ...(withPhoto ? [{ ...photoImg, label: "Image 3: the owner's photo." }] : [])];
  const out = await callStructured({ step: "read_back", ...p, images, schema: PosterReadSchema });
  usage.push(out.usage);
  const copyList = TEXT_SLOTS.flatMap((s) => (slots[s] ? [slots[s]!] : []));
  return { ...judgePoster(out.data, copyList, { photoGiven: withPhoto }), logoNotes: out.data.logo_notes, raw: out.data.text };
}
const readIssues = (r?: ReadCheck) => (r ? [...r.missing.map((w) => `"${w}" can't be read on the render`), ...r.hardToRead.map((x) => `hard to read: ${x}`)] : []);

// The image models, saving what they paint.
const modelUsed: Partial<Record<Painter, string>> = {};
async function paint(painter: Painter, what: string, file: string, text: string, images: Image[]): Promise<{ file: string; model: string } | { error: string }> {
  if (REUSE) {
    for (const ext of ["png", "jpg"]) {
      const from = join(REUSE, "posts", `${file}.${ext}`);
      if (!existsSync(from)) continue;
      const out = `posts/${file}.${ext}`;
      copyFileSync(from, join(runDir, out));
      imageCalls.push({ what: `${what} (reused)`, model: "reused", usd: 0, seconds: 0 });
      return { file: out, model: `reused from ${REUSE}` };
    }
    console.log(`  --reuse: no ${file} in ${REUSE}, painting it`);
  }
  const r = painter === "gemini"
    ? await paintSketch({ apiKey: keys.gemini!, text, images, aspect: poster.aspect, model: modelUsed.gemini ?? null })
    : await paintOpenAI({ apiKey: keys.openai!, text, images, aspect: poster.aspect, model: modelUsed.openai ?? null });
  if (!r.ok) {
    if (r.billed && r.model) imageCalls.push({ what, model: r.model, usd: painter === "gemini" ? (SKETCH.usdPerImage[r.model] ?? SKETCH_WORST_USD) : OPENAI_WORST_USD, seconds: 0 });
    return { error: r.error };
  }
  modelUsed[painter] = r.model;
  imageCalls.push({ what, model: r.model, usd: r.usd, seconds: r.seconds });
  const out = `posts/${file}.${r.mediaType.includes("png") ? "png" : "jpg"}`;
  writeFileSync(join(runDir, out), Buffer.from(r.base64, "base64"));
  return { file: out, model: r.model };
}

/** Where each slot of a composition sits, in percent of the canvas, for the painter. */
async function zonesOf(c: Pick<Composition, "html" | "css">): Promise<string> {
  const file = join(runDir, "posts", "b-zones.html");
  writeFileSync(file, pageHtml(c, /data-slot=["']?photo/.test(c.html)));
  const page = await browser.newPage({ viewport: { width: 1080, height: H } });
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const boxes = (await page.evaluate(`(() => { const P = document.querySelector('.post').getBoundingClientRect(); return [...document.querySelectorAll('[data-slot]')].map((e) => { const r = e.getBoundingClientRect(); return { slot: e.getAttribute('data-slot'), x0: (r.left - P.left) / P.width, x1: (r.right - P.left) / P.width, y0: (r.top - P.top) / P.height, y1: (r.bottom - P.top) / P.height }; }); })()`)) as { slot: string; x0: number; x1: number; y0: number; y1: number }[];
    const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
    const what: Record<string, string> = { wordmark: "the logo", photo: "the owner's photo, pasted in later as a print (paint a soft shadow and two strips of tape just outside its top corners)", headline: "the headline", subhead: "a line of text", date: "the date and time", details: "a line of small text" };
    // A margin around each area, so the art doesn't touch the type (run 2: holly ran into the headline).
    const m = 0.04;
    return boxes.map((b) => `- ${what[b.slot] ?? b.slot}: from ${pct(b.x0 - m)} to ${pct(b.x1 + m)} across, ${pct(b.y0 - m)} to ${pct(b.y1 + m)} down`).join("\n");
  } finally {
    await page.close();
  }
}

const clock = async <T>(key: string, f: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  try { return await f(); } finally { timing[key] = Math.round((Date.now() - t) / 1000); }
};
const usdSince = (n: number) => usage.slice(n).reduce((s, u) => s + u.usd, 0);
const imgUsd = (prefix: string) => imageCalls.filter((c) => c.what.startsWith(prefix)).reduce((s, c) => s + c.usd, 0);

console.log(`Poster spike ${runId}: ${BRAND} / ${poster.id}, ${refs.length} references, painters ${painters.join(" + ")}, ${PLATE_TAKES} plate(s) each${skipC ? ", no C" : ""}`);
const started = Date.now();
const pool: Built[] = [];
for (const [label, name, file] of [["today", "Today's Specs post", "todays-specs-post.png"], ["target", "Scott's target (image model)", "target-image-model.png"]] as const) {
  const src = join(brandDir(BRAND), "compare", file);
  if (existsSync(src)) {
    copyFileSync(src, join(runDir, "posts", file));
    pool.push({ label, name, png: `posts/${file}`, errors: [], probe: [], tries: 0 });
  }
}
const baseImages = [photoImg, logoImg, ...refImgs];
const printKit = loadPrompt("print-kit", {}).system;
const builds: Built[] = [];
let artZones = "";
let wireframe: string | null = null;
const plates: ({ take: number; painter: Painter; file: string; model: string } | { take: number; painter: Painter; error: string })[] = [];
const fulls: Built[] = [];
let critique: ArtCritique | null = null;
let winner: string | null = null;
const blind: Record<string, string> = {};

try {
  // A and B's type layer run side by side; C's painting starts at the same time.
  const u0 = usage.length;
  const cNotes = ["the strongest single idea from the references", "a different hero: let the photo lead", "the boldest version: type and record at full scale"];
  const cJob = skipC
    ? Promise.resolve([] as Built[])
    : clock("C", () =>
        Promise.all(
          painters.flatMap((painter) =>
            Array.from({ length: C_TAKES }, async (_, k) => {
              const label = `C${C_TAKES > 1 ? k + 1 : ""}${painters.length > 1 ? `-${painter}` : ""}`;
              const p = loadPrompt("poster-full", { business_name: briefs.business_name, intent: poster.intent, canvas, copy, kit: fullKit, direction: poster.direction ?? "", images: ["1. The owner's photo.", "2. The brand's real logo.", ...refImgs.map((_, i) => `${i + 3}. Reference poster ${i + 1}.`)].join("\n"), take_note: C_TAKES > 1 ? (cNotes[k] ?? "a different idea from the other takes") : "your best version", logo_spot: "none: this spike paints the logo itself, from the second image" });
              const r = await paint(painter, label, `c-full-poster-${painter}-${k + 1}`, `${p.system}\n\n${p.user}`, [photoImg, logoImg, ...refImgs]);
              const name = `${label}. Image model paints everything (${"error" in r ? painter : r.model})`;
              return ("error" in r ? { label, name, png: null, errors: [r.error], probe: [], tries: 1 } : { label, name, png: r.file, errors: [], probe: [], tries: 1 }) as Built;
            }),
          ),
        ),
      );
  const aJob = skipA ? Promise.resolve(null) : clock("A", () => compose({ label: "A", name: "A. HTML with references and print textures", appendix: printKit, images: baseImages }));
  const typeJob = clock("B-layout", () => compose({ label: "B-layout", name: "B. Type layer (before the plate)", appendix: `${printKit}\n\n${loadPrompt("plate-type", { fit: "Design the type layer for a painted plate." }).system}`, images: baseImages }));
  const [a, layer] = await Promise.all([aJob, typeJob]);
  if (a) {
    builds.push(a);
    console.log(`  A: ${a.png && !issueText(a).length ? "passed the checks" : `flagged: ${issueText(a).join("; ")}`}`);
  }
  if (!layer.composition || layer.errors.length) throw new Error(`The type layer failed the code checks: ${layer.errors.join("; ")}`);
  artZones = layer.composition.rationale.find((r) => /art/i.test(r.decision))?.choice ?? "Paper texture over the whole canvas; a record-shop illustration in the empty areas.";
  console.log(`  art zones: ${artZones}`);

  // B: wireframe, plates, fit.
  wireframe = (await render(layer.composition, "b-wireframe", { wireframe: true })).png;
  // The painter gets the layout in words, not the wireframe: shown gray blocks, it paints them.
  const zones = await zonesOf(layer.composition);
  const notes = ["the brand's signature look, closest to the references", "bolder: larger illustration, a stronger color band, more worn print"];
  const bJob = clock("B", async () => {
    let n = 0;
    await Promise.all(
      painters.map(async (painter) => {
        for (let t = 1; t <= PLATE_TAKES; t++) {
          const take = ++n;
          const p = loadPrompt("plate", { business_name: briefs.business_name, intent: poster.intent, canvas, art_zones: artZones, zones, kit: lookKit, take: String(t), take_note: notes[t - 1] ?? "a different idea from the other variations" });
          const r = await paint(painter, `B${take}`, `b-plate-${take}-${painter}`, `${p.system}\n\n${p.user}`, refImgs.map((i, k) => ({ ...i, label: `Image ${k + 1}: reference poster ${k + 1}.` })));
          plates.push({ take, painter, ...r });
          console.log("error" in r ? `  plate ${take} (${painter}) failed: ${r.error}` : `  plate ${take}: ${r.model}`);
        }
      }),
    );
    const out: Built[] = [];
    await Promise.all(
      plates.filter((p): p is { take: number; painter: Painter; file: string; model: string } => "file" in p).map(async (p) => {
        const u = usage.length;
        const first = await render(layer.composition!, `b${p.take}-first`, { plate: p.file });
        const before: Built = { ...layer, label: `B${p.take}`, name: `B${p.take}. Painted plate (${p.model}), real type`, png: first.png, probe: first.probe, plate: p.file };
        before.readBack = await readBack(join(runDir, first.png));
        // Fit the type to the plate once, with both in view.
        const plateImg = jpeg(await small(join(runDir, p.file), 1200), `Image ${baseImages.length + 1}: the painted plate, alone.`);
        const renderImg = jpeg(await small(join(runDir, first.png), 1200), `Image ${baseImages.length + 2}: your type layer over the plate, as rendered.`);
        const fitNotes = [
          "The plate has been painted (the second-to-last image) and your layer has been put over it (the last image). Fit the type to the art: keep the layout, but change what the render shows is wrong. Type that sits on a painted color band needs a color that reads on that band (cream on a dark band). Move a slot off any illustration it collides with. Make the type look printed like the plate (worn ink, matching weight). Don't add CSS panels that hide the art.",
          ...issueText(before).map((x) => `- code: ${x}`),
          ...readIssues(before.readBack).map((x) => `- reading the render: ${x}`),
        ].join("\n");
        const fitted = await compose({ label: `B${p.take}`, name: `B${p.take}. Painted plate (${p.model}), real type`, appendix: `${printKit}\n\n${loadPrompt("plate-type", { fit: "" }).system}`, images: [...baseImages, plateImg, renderImg], plate: p.file, fitNotes, from: before });
        if (fitted.png && fitted.png !== before.png && !fitted.errors.length) fitted.readBack = await readBack(join(runDir, fitted.png));
        const score = (b: Built) => issueText(b).length + readIssues(b.readBack).length * 2 + (b.png ? 0 : 99);
        const keep = fitted.png && !fitted.errors.length && score(fitted) <= score(before) ? fitted : before;
        keep.usd = usdSince(u) + imgUsd(`B${p.take}`);
        out.push(keep);
      }),
    );
    return out.sort((x, y) => x.label.localeCompare(y.label));
  });
  const [bs, c] = await Promise.all([bJob, cJob]);
  builds.push(...bs);
  for (const b of bs) console.log(`  ${b.label}: ${issueText(b).length || readIssues(b.readBack).length ? `flagged: ${[...issueText(b), ...readIssues(b.readBack)].join("; ")}` : "passed the checks"}`);
  for (const x of c) {
    if (x.png) x.readBack = await readBack(join(runDir, x.png), true);
    fulls.push(x);
    console.log(`  ${x.label}: ${x.png ? `invented [${x.readBack?.invented.join(", ")}], missing [${x.readBack?.missing.join(", ")}], logo ${x.readBack?.logo}, photo ${x.readBack?.photo}${x.readBack?.problems.length ? `: ${x.readBack.problems.join("; ")}` : ""}` : x.errors.join("; ")}`);
  }
  if (a?.png) a.readBack = await readBack(join(runDir, a.png));
  void u0;

  const passed = (r?: ReadCheck) => !!r && r.pass;
  if (fulls.length) console.log(`  C passed the read-back ${fulls.filter((f) => passed(f.readBack)).length} of ${fulls.length} times`);

  // Blind critique: today, the target, A, B1..n, C.
  const judged = [...pool, ...builds.filter((b) => b.png), ...fulls.filter((f) => f.png)];
  const order = judged.map((b) => ({ b, k: Math.random() })).sort((x, y) => x.k - y.k).map((x) => x.b);
  order.forEach((b, i) => (blind[String(i + 1)] = b.label));
  const candidates = order.map((_, i) => `Candidate ${i + 1} (image ${i + 1}).`).join("\n");
  const cPrompt = loadPrompt("art-critique", { kit: fullKit, business_name: briefs.business_name, intent: poster.intent, goal: poster.goal, copy, candidates });
  const images: Image[] = [];
  for (const [i, b] of order.entries()) images.push(jpeg(await small(join(runDir, b.png!), 1080), `Image ${i + 1}: candidate ${i + 1}.`));
  const system = `${cPrompt.system}\n\nThis time some candidates may have been painted by an image model, so don't assume code checked them: read their words against <copy> and list anything wrong under honesty. Judge them as posters, printed and on Instagram.`;
  for (let n = 1; n <= 2; n++) {
    const cOut = await callStructured({ step: "art_critique", system, user: cPrompt.user, images, schema: ArtCritiqueSchema });
    usage.push(cOut.usage);
    critique = cOut.data;
    if (order.every((_, i) => critique!.candidates.some((c) => c.label.replace(/\D/g, "") === String(i + 1)))) break;
  }
  winner = blind[critique!.winner.replace(/\D/g, "")] ?? null;
  console.log(`  critic picked: ${winner}`);

  const claudeUsd = usage.reduce((s, u) => s + u.usd, 0);
  const imageUsd = imageCalls.reduce((s, c) => s + c.usd, 0);
  const seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, brand: BRAND, poster, modelUsed, models: { compose_print: STEPS.compose_print, read_back: STEPS.read_back, art_critique: STEPS.art_critique }, artZones, wireframe, plates, builds, fulls, pool, critique, blind, winner, imageCalls, usage, timing, claudeUsd, imageUsd, seconds }, null, 2));
  writeFileSync(join(runDir, "index.html"), reviewPage({ claudeUsd, imageUsd, seconds }));
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(runDir, "index.html")).href, { waitUntil: "load" });
  await page.locator(".sheet").first().screenshot({ path: join(runDir, "sheet-posters.png") });
  await page.locator(".sheet").nth(1).screenshot({ path: join(runDir, "sheet-plates.png") });
  await page.close();
  console.log(`\nApproximate cost: $${(claudeUsd + imageUsd).toFixed(2)} (Claude $${claudeUsd.toFixed(2)}, image model $${imageUsd.toFixed(2)}), ${seconds}s`);
  console.log(`Review page: ${join(runDir, "index.html")}`);
} finally {
  await browser.close();
}

function reviewPage(cost: { claudeUsd: number; imageUsd: number; seconds: number }): string {
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const scoreOf = (label: string) => {
    const n = Object.entries(blind).find(([, l]) => l === label)?.[0];
    return critique?.candidates.find((c) => c.label.replace(/\D/g, "") === n);
  };
  const facts = (r?: ReadCheck) =>
    r
      ? `<br><span class="${r.invented.length || r.missing.length || r.logo !== "same" ? "bad" : "ok"}">Read back: ${r.invented.length ? `invented ${r.invented.map(esc).join(", ")}; ` : ""}${r.missing.length ? `missing ${r.missing.map(esc).join(", ")}; ` : ""}${!r.invented.length && !r.missing.length ? "every word matches; " : ""}logo ${esc(r.logo)}${r.logo !== "same" ? ` (${esc(r.logoNotes)})` : ""}</span>${r.hardToRead.length ? `<br><span class="bad">Hard to read: ${r.hardToRead.map(esc).join("; ")}</span>` : ""}`
      : "";
  const tile = (b: Built) => {
    const s = scoreOf(b.label);
    const flags = issueText(b);
    return `<figure class="${winner === b.label ? "win" : ""}">
      ${b.png ? `<img src="${b.png}" alt="">` : `<div class="none">${esc(b.errors.join("; ") || "No image")}</div>`}
      <figcaption><b>${esc(b.name)}</b>${winner === b.label ? ' <span class="pick">Critic\'s pick</span>' : ""}
      ${s ? `<br><span class="sc">idea ${s.idea} · stop ${s.stop} · brand ${s.brand} · legible ${s.legible}</span><br><span class="n">${esc(s.notes)}</span>${s.honesty.length ? `<br><span class="bad">Honesty: ${s.honesty.map(esc).join("; ")}</span>` : ""}` : ""}
      ${facts(b.readBack)}
      ${flags.length ? `<br><span class="bad">Checks: ${flags.map(esc).join("; ")}</span>` : ""}</figcaption></figure>`;
  };
  const cUsd = imgUsd("C");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Poster spike: painted plate, real type</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:32px;background:#ececea;color:#111}h1{font-size:28px}h2{font-size:17px;margin:0 0 14px}
section{background:#fff;border-radius:20px;padding:24px;margin:0 0 28px}.sheet{background:#fff;padding:8px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;align-items:start}
figure{margin:0}figure img{width:100%;display:block;border-radius:6px}figure.win img{outline:4px solid #e5372b;outline-offset:3px}
figcaption{font-size:12.5px;color:#333;margin-top:8px}.n,.meta{color:#666}.sc{font-family:ui-monospace,monospace;font-size:12px}
.pick{background:#e5372b;color:#fff;border-radius:99px;padding:1px 8px;font-size:11px}.none{aspect-ratio:1;display:grid;place-items:center;background:#eee;border-radius:6px;color:#888;padding:12px;text-align:center}
.bad{color:#b3261e}.ok{color:#1b6e3a}
</style></head><body><h1>Poster spike: painted plate, real type</h1>
<p>Good Company Records &amp; CDs, "${esc(slots.headline)}". Three builds from one brief and ${refs.length} reference posters, judged blind beside today's Specs post and Scott's image-model target. Every poster's words were read back from the image. Run ${esc(runId)}.</p>
<section><div class="sheet"><h2>The posters</h2><div class="row">
  ${[...pool, ...builds, ...fulls].map(tile).join("")}
</div></div>
${critique ? `<p><b>Why the pick:</b> ${esc(critique.why)}</p>${critique.revision.length ? `<p><b>Revision notes:</b></p><ul>${critique.revision.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : ""}
</section>
<section><div class="sheet"><h2>How B was made: wireframe → painted plate → type on top</h2><div class="row">
  ${wireframe ? `<figure><img src="${wireframe}" alt=""><figcaption><b>Wireframe</b> from Claude's type layer</figcaption></figure>` : ""}
  ${plates.map((p) => ("file" in p ? `<figure><img src="${p.file}" alt=""><figcaption><b>Plate ${p.take}</b> (${esc(p.model)}, no text)</figcaption></figure>` : `<div class="none">Plate ${p.take} failed: ${esc(p.error)}</div>`)).join("")}
  ${builds.filter((b) => b.label.startsWith("B")).map((b) => `<figure><img src="${b.png}" alt=""><figcaption><b>${esc(b.name)}</b></figcaption></figure>`).join("")}
</div></div>
<p class="meta"><b>Art zones:</b> ${esc(artZones)}</p>
</section>
<p class="meta">${cost.seconds}s · Claude $${cost.claudeUsd.toFixed(2)} · image model $${cost.imageUsd.toFixed(2)} (${imageCalls.map((c) => `${c.what} ${c.seconds}s`).join(", ")}) · C alone $${cUsd.toFixed(2)} plus its read-back · timing ${esc(JSON.stringify(timing))} · blind ${esc(JSON.stringify(blind))}</p>
</body></html>`;
}
