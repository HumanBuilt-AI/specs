// Speed spike (Nov 27, plan "Specs: new kit flow build plan"): can the painted path hit Scott's
// targets, a first look in 5–15 s and a finished output in under a minute? Good Company only.
// Paints the poster-full poster (the C build that won the poster spike) as a tall 1024×1536 image,
// all jobs at once:
//
//   - one take each at quality low, medium and high (how much quality costs in seconds);
//   - two more medium takes, so three medium takes run side by side (parallel takes instead of
//     paint-then-repaint: how long until the first one passes);
//   - one medium take streamed, to time the first rough preview (the 5–15 s first look).
//
// Every finished take is read back by Claude and judged in code (core/poster.ts), exactly as the
// app's poster job does. Writes output/speed-<run-id>/index.html with the images, times and results.
//
// Usage: npm run spike -- spike/speed.ts [--model gpt-image-1.5]
// Needs ANTHROPIC_API_KEY and OPENAI_API_KEY in .env. Neither is logged. About $1–1.50.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { chromium } from "playwright";
import YAML from "yaml";
import { TEXT_SLOTS, type TextSlot } from "../core/compose.ts";
import { brandDir, OUTPUT_DIR, ROOT } from "./lib/paths.ts";
import { loadChunks, formatChunks } from "./lib/kit.ts";
import { loadPrompt } from "./lib/prompts.ts";
import { callStructured, type Image, type Usage } from "./lib/claude.ts";
import { paintOpenAI } from "../core/image-openai.ts";
import { PosterReadSchema, judgePoster, type PosterVerdict } from "../core/poster.ts";

const BRAND = "good-company";
const SIZE = "1024x1536";
const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const MODEL = mi >= 0 ? args[mi + 1] ?? null : null;
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("OPENAI_API_KEY is missing from .env.");

type Ref = { file: string; borrow: string; ignore?: string };
type Poster = { intent: string; direction?: string; season?: string; photo: string; reads_as?: string; slots: Partial<Record<TextSlot, string>>; references: Ref[] };
const poster = YAML.parse(readFileSync(join(brandDir(BRAND), "poster.yaml"), "utf8")) as Poster;
const refs = poster.references ?? [];
const photoAbs = join(brandDir(BRAND), poster.photo);
const logoAbs = join(brandDir(BRAND), "logo.png");
for (const f of [photoAbs, logoAbs, ...refs.map((r) => join(brandDir(BRAND), r.file))]) if (!existsSync(f)) throw new Error(`Missing ${relative(ROOT, f)} (the reference posters live on Scott's Mac only).`);
const slots = Object.fromEntries(TEXT_SLOTS.map((k) => [k, poster.slots[k] ?? null])) as Record<TextSlot, string | null>;
const copyText = TEXT_SLOTS.filter((s) => slots[s]).map((s) => `${s}: "${slots[s]}" (${slots[s]!.length} characters)`).join("\n");
const copy = copyText + (poster.reads_as ? `\nReads as: "${poster.reads_as}"` : "") + (poster.season ? `\nSeason: ${poster.season}` : "");
const copyList = TEXT_SLOTS.flatMap((s) => (slots[s] ? [slots[s]!] : []));
const briefs = YAML.parse(readFileSync(join(brandDir(BRAND), "briefs.yaml"), "utf8")) as { business_name: string };
const chunks = loadChunks(BRAND);
const fullKit = formatChunks(["positioning-core", "energy", "references", "layout-system", "visual-system", "art-direction", "social-rules", "guardrails"].filter((id) => chunks.has(id)).map((id) => chunks.get(id)!));
const canvas = "1024 × 1536 px (2:3), a tall poster for print (11×17) and Instagram stories. Keep every word well inside the edges.";

const runId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
const runDir = join(OUTPUT_DIR, `speed-${runId}`);
mkdirSync(runDir, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const usage: Usage[] = [];

async function small(abs: string, max = 1400): Promise<string> {
  const page = await browser.newPage({ viewport: { width: max, height: max } });
  const ext = extname(abs).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  await page.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:${mime};base64,${readFileSync(abs).toString("base64")}" style="max-width:${max}px;max-height:${max}px;display:block">`);
  const buf = await page.locator("#i").screenshot({ type: "jpeg", quality: 86 });
  await page.close();
  return buf.toString("base64");
}
const jpeg = (base64: string, label: string): Image => ({ mediaType: "image/jpeg", base64, label });
const photoImg = jpeg(await small(photoAbs), "Image 1: the owner's photo.");
const logoImg: Image = { mediaType: "image/png", base64: readFileSync(logoAbs).toString("base64"), label: "Image 2: the brand's real logo." };
const refImgs: Image[] = [];
for (const [i, r] of refs.entries()) refImgs.push(jpeg(await small(join(brandDir(BRAND), r.file)), `Image ${i + 3}: reference poster ${i + 1}. ${r.borrow}`));

const p = loadPrompt("poster-full", { business_name: briefs.business_name, intent: poster.intent, canvas, copy, kit: fullKit, direction: poster.direction ?? "", images: ["1. The owner's photo.", "2. The brand's real logo.", ...refImgs.map((_, i) => `${i + 3}. Reference poster ${i + 1}.`)].join("\n"), take_note: "your best version" });
const text = `${p.system}\n\n${p.user}`;

type Job = { label: string; quality: "low" | "medium" | "high"; stream?: boolean };
const jobs: Job[] = [
  { label: "low", quality: "low" },
  { label: "medium-1", quality: "medium" },
  { label: "medium-2", quality: "medium" },
  { label: "medium-3", quality: "medium" },
  { label: "high", quality: "high" },
  { label: "medium-streamed", quality: "medium", stream: true },
];
type Result = { label: string; quality: string; model?: string; paintS?: number; firstPartialS?: number; partials: string[]; file?: string; readS?: number; doneS?: number; verdict?: PosterVerdict; error?: string };

async function readBack(pngAbs: string): Promise<PosterVerdict> {
  const rp = loadPrompt("read-back", { copy: copyText, photo_line: "The owner's photo is the third." });
  const images = [jpeg(await small(pngAbs, 1200), "Image 1: the poster."), { ...logoImg, label: "Image 2: the brand's real logo." }, { ...photoImg, label: "Image 3: the owner's photo." }];
  const out = await callStructured({ step: "read_back", ...rp, images, schema: PosterReadSchema });
  usage.push(out.usage);
  return judgePoster(out.data, copyList, { photoGiven: true });
}

const t0 = Date.now();
const since = () => (Date.now() - t0) / 1000;
console.log(`Painting ${jobs.length} takes at once (${SIZE})…`);
const results = await Promise.all(
  jobs.map(async (j): Promise<Result> => {
    const r: Result = { label: j.label, quality: j.quality, partials: [] };
    const paint = await paintOpenAI({
      apiKey: KEY, text, images: [photoImg, logoImg, ...refImgs], aspect: "4:5", model: MODEL, size: SIZE, quality: j.quality,
      ...(j.stream ? { partials: 2, onPartial: (x: { index: number; base64: string; seconds: number }) => {
        r.firstPartialS ??= Math.round(x.seconds * 10) / 10;
        const f = `${j.label}-partial-${x.index}.png`;
        writeFileSync(join(runDir, f), Buffer.from(x.base64, "base64"));
        r.partials.push(`${f} at ${x.seconds.toFixed(1)} s`);
      } } : {}),
    });
    if (!paint.ok) return { ...r, error: paint.error };
    r.model = paint.model;
    r.paintS = paint.seconds;
    r.file = `${j.label}.png`;
    writeFileSync(join(runDir, r.file), Buffer.from(paint.base64, "base64"));
    const rs = Date.now();
    try {
      r.verdict = await readBack(join(runDir, r.file));
    } catch (e) {
      r.error = `read-back: ${(e as Error).message}`;
    }
    r.readS = Math.round((Date.now() - rs) / 100) / 10;
    r.doneS = Math.round(since());
    console.log(`  ${j.label}: painted in ${r.paintS} s${r.firstPartialS ? ` (first preview ${r.firstPartialS} s)` : ""}, read back in ${r.readS} s, ${r.verdict?.pass ? "PASSED" : "failed"}${r.verdict && !r.verdict.pass ? `: ${r.verdict.problems.join("; ")}` : ""}`);
    return r;
  }),
);
await browser.close();

const mediums = results.filter((r) => r.label.startsWith("medium-") && r.label !== "medium-streamed");
const firstPass = mediums.filter((r) => r.verdict?.pass).sort((a, b) => (a.doneS ?? 1e9) - (b.doneS ?? 1e9))[0];
const claudeUsd = usage.reduce((s, u) => s + u.usd, 0);
const summary = {
  run: runId,
  model: results.find((r) => r.model)?.model ?? null,
  size: SIZE,
  wallSeconds: Math.round(since()),
  firstPreviewSeconds: results.find((r) => r.firstPartialS)?.firstPartialS ?? null,
  threeMediumTakes: { passed: mediums.filter((r) => r.verdict?.pass).length, of: mediums.length, firstPassDoneSeconds: firstPass?.doneS ?? null },
  claudeUsd: Math.round(claudeUsd * 100) / 100,
  results: results.map(({ verdict, ...r }) => ({ ...r, pass: verdict?.pass ?? false, problems: verdict?.problems ?? [] })),
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
writeFileSync(
  join(runDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Speed spike ${runId}</title><style>body{font:14px system-ui;margin:32px;background:#ececea}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.c{background:#fff;border-radius:16px;padding:12px}img{width:100%;border-radius:8px}.pass{color:#1e7a3c}.fail{color:#d93a1f}</style>
<h1>Speed spike · Good Company · ${SIZE}</h1>
<p>Model ${esc(summary.model ?? "?")} · all takes painted at once · wall time ${summary.wallSeconds} s · first preview ${summary.firstPreviewSeconds ?? "none"} s · medium takes passed ${summary.threeMediumTakes.passed} of ${summary.threeMediumTakes.of}, first pass done at ${summary.threeMediumTakes.firstPassDoneSeconds ?? "never"} s · read-backs $${summary.claudeUsd}</p>
<div class="g">${results
    .map((r) => `<div class="c"><h3>${esc(r.label)}</h3>${r.file ? `<img src="${r.file}">` : ""}<p>painted ${r.paintS ?? "?"} s · read ${r.readS ?? "?"} s · done at ${r.doneS ?? "?"} s${r.firstPartialS ? ` · first preview ${r.firstPartialS} s` : ""}</p><p class="${r.verdict?.pass ? "pass" : "fail"}">${r.error ? esc(r.error) : r.verdict?.pass ? "Passed every check" : esc((r.verdict?.problems ?? []).join("; "))}</p>${r.partials.map((x) => `<p class="small">${esc(x)}</p><img src="${x.split(" ")[0]}">`).join("")}</div>`)
    .join("")}</div>`,
);
console.log(`\nWall time ${summary.wallSeconds} s. First preview ${summary.firstPreviewSeconds ?? "none"} s. Medium takes passed ${summary.threeMediumTakes.passed}/${summary.threeMediumTakes.of}; first pass done at ${summary.threeMediumTakes.firstPassDoneSeconds ?? "never"} s.`);
console.log(`Review page: ${relative(ROOT, join(runDir, "index.html"))}`);
