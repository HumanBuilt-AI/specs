// A poster's background work (see server/poster.ts). Runs in a Netlify background function, so a
// step may take minutes. It first checks the job's token and claims the run, so a stray or
// repeated trigger (Netlify retries a failed background run) does nothing and spends nothing.
//
// Paint (prompts/poster-full.md, the OpenAI image model; the logo spot left as plain paper) → read back (prompts/read-back.md, Claude)
// → judge in code (core/poster.ts). A failed check gets one repaint told what failed; a second
// fail ends in "fallback". Nothing the checks haven't passed is ever served.
import "server-only";
import { LIMITS } from "../core/limits.ts";
import { ComposeSchema, TEXT_SLOTS, type Composition } from "../core/compose.ts";
import { checkBold, fillEchoes } from "../core/bold.ts";
import { asData, fillPrompt } from "../core/prompts.ts";
import { PosterReadSchema, judgePoster, logoSpotWords, repaintNote, type PosterVerdict } from "../core/poster.ts";
import { paintOpenAI, OPENAI_WORST_USD } from "../core/image-openai.ts";
import type { Image } from "../core/claude.ts";
import { CONTENT } from "./generated/content.ts";
import { guardedCall, type Deps } from "./handlers.ts";
import { reserve, settle } from "./spend.ts";
import { updateSession } from "./sessions.ts";
import { inputs, pick, copyOf } from "./bold-run.ts";
import { loadPosterJob, posterImageKey, posterPlateKey, updatePosterJob, type PosterJob, type PosterTrigger } from "./poster.ts";

/** The painter, swappable in tests. Real runs use paintOpenAI. */
export type Paint = typeof paintOpenAI;

/** Runs a poster job. Never throws: failures are written to the job for the browser. */
export async function runPoster(deps: Deps, t: PosterTrigger, openaiKey: string | undefined, paint: Paint = paintOpenAI): Promise<void> {
  const job = await loadPosterJob(deps.kv, t.sessionId, t.postId);
  if (!job || job.token !== t.token) return; // not a job we started
  let claimed = false;
  await updatePosterJob(deps.kv, t.sessionId, t.postId, (j) => {
    if (j.status !== "painting" || j.ran) return j;
    claimed = true;
    return { ...j, ran: true };
  });
  if (!claimed) return;
  try {
    if (!openaiKey) throw new Error("OPENAI_API_KEY isn't set.");
    await paintAndCheck(deps, t, openaiKey, paint);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Poster failed:", message);
    await updatePosterJob(deps.kv, t.sessionId, t.postId, (j) => ({ ...j, status: "failed", stage: "Stopped", error: message.slice(0, 300) })).catch(() => {});
    // Our failure, not the owner's: the visit gets its poster back to try again.
    await updateSession(deps.kv, t.sessionId, (s) => ({ ...s, postersUsed: Math.max(0, (s.postersUsed ?? 1) - 1) })).catch(() => {});
  }
}

async function paintAndCheck(deps: Deps, t: PosterTrigger, apiKey: string, paint: Paint) {
  const x = await inputs(deps, t);
  const set = (change: (j: PosterJob) => PosterJob) => updatePosterJob(deps.kv, t.sessionId, t.postId, change);
  const size = { width: 1080, height: x.aspect === "4:5" ? 1350 : 1080 };
  const business = x.kit.id === "session" ? asData(x.kit.businessName) : x.kit.businessName;
  const copy = copyOf(x.slots);
  const copyList = TEXT_SLOTS.flatMap((s) => (x.slots[s] ? [x.slots[s]!] : []));
  const kit = pick(x.chunks, ["positioning-core", "energy", "layout-system", "visual-system", "art-direction", "social-rules", "guardrails"]);
  // The painter never sees the logo: code sets the owner's real file in the logo spot afterwards
  // (the browser composites it), so it can't come back misspelled or twice (Nov 27 speed run 2).
  const images: Image[] = x.photo ? [x.photo] : [];
  const imageList = [x.photo ? `1. The owner's photo. ${x.photoAlt}` : "None: no photo was given.", x.logo ? "The logo file is kept back for code to place." : "No logo file was given."].join("\n");
  const spot = logoSpotWords();

  let verdict: PosterVerdict | null = null;
  for (let n = 1; n <= LIMITS.posterPaints; n++) {
    await set((j) => ({ ...j, status: "painting", stage: n === 1 ? "Painting the poster" : "Repainting what didn't pass" }));
    const filled = fillPrompt("poster-full", CONTENT.prompts["poster-full"], {
      business_name: business,
      intent: x.post.intent,
      canvas: `${size.width} × ${size.height} px (${x.aspect})`,
      images: imageList,
      copy,
      direction: `A printed poster for this post. Its goal: ${asData(x.post.brief.goal)}`,
      kit,
      take_note: verdict ? repaintNote(verdict) : "your best version",
      logo_spot: spot,
    });
    const reservation = await reserve(deps.kv, deps.settings, deps.now(), OPENAI_WORST_USD);
    const r = await paint({ apiKey, text: `${filled.system}\n\n${filled.user}`, images, aspect: x.aspect, timeoutMs: 240_000 });
    await settle(deps.kv, reservation, r.ok ? r.usd : r.billed ? OPENAI_WORST_USD : 0);
    if (!r.ok) throw new Error(`The image model didn't paint the poster: ${r.error}`);
    const bytes = Buffer.from(r.base64, "base64");
    await deps.kv.putBytes(posterImageKey(t.sessionId, t.postId, n), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { attempt: n, mediaType: r.mediaType });

    await set((j) => ({ ...j, status: "checking", stage: "Reading every word back" }));
    const rb = fillPrompt("read-back", CONTENT.prompts["read-back"], {
      copy,
      photo_line: x.photo ? "The owner's photo is the third." : "No owner photo is given.",
      logo_line: x.logo ? `The logo spot is ${spot}. The real logo goes there later, so the painting should have none.` : "No logo spot: the business name is painted where the logo would go.",
    });
    const poster: Image = { mediaType: r.mediaType as Image["mediaType"], base64: r.base64, label: "Image 1: the poster." };
    const checkImages: Image[] = [
      poster,
      ...(x.logo ? [{ ...x.logo, label: "Image 2: the brand's real logo." }] : [{ ...poster, label: "Image 2: no logo file was given; ignore this image and answer logo: missing." }]),
      ...(x.photo ? [{ ...x.photo, label: "Image 3: the owner's photo." }] : []),
    ];
    const read = await guardedCall(deps, "read_back", { ...rb, images: checkImages }, PosterReadSchema);
    verdict = judgePoster(read.data, copyList, { photoGiven: Boolean(x.photo), logoGiven: Boolean(x.logo), logoByCode: Boolean(x.logo) });
    const attempt = { n, pass: verdict.pass, problems: verdict.problems.slice(0, 12).map((p) => p.slice(0, 300)), model: r.model, seconds: r.seconds };
    if (verdict.pass) {
      await set((j) => ({ ...j, status: "done", stage: "Done", attempts: [...j.attempts, attempt], result: { attempt: n, mediaType: r.mediaType } }));
      return;
    }
    await set((j) => ({ ...j, attempts: [...j.attempts, attempt] }));
  }
  // Both paintings failed a check: build the B version instead, a painted plate with the real type
  // set over it by code, so every word, the logo and the photo are exact by construction.
  await set((j) => ({ ...j, status: "fallback", stage: "Building the backup version" }));
  await buildB(deps, t, x, apiKey, paint, set, { business, copy, kit, canvas: `${size.width} × ${size.height} px (${x.aspect}). The brand's safe margin is var(--safe-margin).` });
}

async function buildB(
  deps: Deps,
  t: PosterTrigger,
  x: Awaited<ReturnType<typeof inputs>>,
  apiKey: string,
  paint: Paint,
  set: (change: (j: PosterJob) => PosterJob) => Promise<PosterJob>,
  o: { business: string; copy: string; kit: string; canvas: string },
) {
  const printKit = fillPrompt("print-kit", CONTENT.prompts["print-kit"], {}).system;
  const plateType = fillPrompt("plate-type", CONTENT.prompts["plate-type"], { fit: "Design the type layer for a painted plate." }).system;
  const designKit = pick(x.chunks, ["energy", "layout-system", "visual-system", "art-direction", "social-rules"]);
  const photoLine = x.photo ? `The first image attached. ${x.photoAlt}` : "None.";
  const logoLine = x.logo
    ? `The ${x.photo ? "second" : "first"} image attached: the brand's real logo, placed by code in the wordmark slot.`
    : `No logo image; the wordmark slot gets the lockup lines: ${x.kit.wordmarkLines.map(asData).join(" / ")}.`;
  const images: Image[] = [...(x.photo ? [x.photo] : []), ...(x.logo ? [x.logo] : [])];

  // The type layer, checked in code (every slot, the photo when there is one), with one fix.
  let layer: Composition | null = null;
  let last: { c: Composition; errors: string[] } | null = null;
  for (let n = 1; n <= 2 && !layer; n++) {
    const feedback = last ? `<previous_attempt_sent_back>\nYour previous HTML:\n${last.c.html}\n\nYour previous CSS:\n${last.c.css}\n\nProblems found by code:\n${last.errors.map((e) => `- ${e}`).join("\n")}\n</previous_attempt_sent_back>` : "";
    const p = fillPrompt("compose-bold", CONTENT.prompts["compose-bold"], { kit: designKit, tokens: x.kit.tokensCss, business_name: o.business, intent: x.post.intent, goal: asData(x.post.brief.goal), direction: "A printed poster for this post, as strong as a screen-printed flyer. Its art is painted afterwards under your type.", canvas: o.canvas, copy: o.copy, photo: photoLine, logo: logoLine, feedback });
    const out = await guardedCall(deps, "compose_print", { system: `${p.system}\n\n${printKit}\n\n${plateType}`, user: p.user, images }, ComposeSchema);
    const check = checkBold(out.data, x.slots, Boolean(x.photo));
    if (check.ok) layer = out.data;
    else last = { c: out.data, errors: check.errors };
  }
  if (!layer) throw new Error(`The backup layout didn't pass the checks: ${last?.errors.join("; ") ?? "no layout"}`);

  // The plate: text-free art, painted around the type layer's art zones.
  await set((j) => ({ ...j, stage: "Painting the backup art" }));
  const artZones = layer.rationale.find((r) => /art/i.test(r.decision))?.choice ?? "Paper texture over the whole canvas, with the illustration in the open areas.";
  const pp = fillPrompt("plate", CONTENT.prompts.plate, {
    business_name: o.business,
    intent: x.post.intent,
    canvas: o.canvas,
    art_zones: asData(artZones),
    zones: "Not measured. Keep plain, calm paper wherever the art zones above leave room for the type, the logo and the photo.",
    kit: pick(x.chunks, ["energy", "visual-system", "art-direction"]),
    take: "1",
    take_note: "the brand's signature look",
  });
  const reservation = await reserve(deps.kv, deps.settings, deps.now(), OPENAI_WORST_USD);
  const r = await paint({ apiKey, text: `${pp.system}\n\n${pp.user}`, images: [], aspect: x.aspect, timeoutMs: 240_000 });
  await settle(deps.kv, reservation, r.ok ? r.usd : r.billed ? OPENAI_WORST_USD : 0);
  if (!r.ok) throw new Error(`The image model didn't paint the backup art: ${r.error}`);
  const bytes = Buffer.from(r.base64, "base64");
  await deps.kv.putBytes(posterPlateKey(t.sessionId, t.postId), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { mediaType: r.mediaType });
  await set((j) => ({
    ...j,
    status: "b_ready",
    stage: "Done",
    b: { html: fillEchoes(layer!.html, x.slots).slice(0, 30000), css: layer!.css.slice(0, 30000), usesPhoto: Boolean(x.photo) && /data-slot=["']?photo/.test(layer!.html), rationale: layer!.rationale.slice(0, 12), plateMediaType: r.mediaType },
  }));
}
