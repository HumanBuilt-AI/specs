// A poster's background work (see server/poster.ts). Runs in a Netlify background function, so a
// step may take minutes. It first checks the job's token and claims the run, so a stray or
// repeated trigger (Netlify retries a failed background run) does nothing and spends nothing.
//
// Paint (prompts/poster-full.md, the OpenAI image model) → read back (prompts/read-back.md, Claude)
// → judge in code (core/poster.ts). A failed check gets one repaint told what failed; a second
// fail ends in "fallback". Nothing the checks haven't passed is ever served.
import "server-only";
import { LIMITS } from "../core/limits.ts";
import { TEXT_SLOTS } from "../core/compose.ts";
import { asData, fillPrompt } from "../core/prompts.ts";
import { PosterReadSchema, judgePoster, repaintNote, type PosterVerdict } from "../core/poster.ts";
import { paintOpenAI, OPENAI_WORST_USD } from "../core/image-openai.ts";
import type { Image } from "../core/claude.ts";
import { CONTENT } from "./generated/content.ts";
import { guardedCall, type Deps } from "./handlers.ts";
import { reserve, settle } from "./spend.ts";
import { inputs, pick, copyOf } from "./bold-run.ts";
import { loadPosterJob, posterImageKey, updatePosterJob, type PosterJob, type PosterTrigger } from "./poster.ts";

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
  const images: Image[] = [...(x.photo ? [x.photo] : []), ...(x.logo ? [x.logo] : [])];
  const imageList = [
    ...(x.photo ? [`${1}. The owner's photo. ${x.photoAlt}`] : []),
    ...(x.logo ? [`${x.photo ? 2 : 1}. The brand's real logo.`] : []),
  ].join("\n") || "None: no photo or logo was given. Set the business name in the heading font where the logo would go.";

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
    });
    const reservation = await reserve(deps.kv, deps.settings, deps.now(), OPENAI_WORST_USD);
    const r = await paint({ apiKey, text: `${filled.system}\n\n${filled.user}`, images, aspect: x.aspect, timeoutMs: 240_000 });
    await settle(deps.kv, reservation, r.ok ? r.usd : r.billed ? OPENAI_WORST_USD : 0);
    if (!r.ok) throw new Error(`The image model didn't paint the poster: ${r.error}`);
    const bytes = Buffer.from(r.base64, "base64");
    await deps.kv.putBytes(posterImageKey(t.sessionId, t.postId, n), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { attempt: n, mediaType: r.mediaType });

    await set((j) => ({ ...j, status: "checking", stage: "Reading every word back" }));
    const rb = fillPrompt("read-back", CONTENT.prompts["read-back"], { copy, photo_line: x.photo ? "The owner's photo is the third." : "No owner photo is given." });
    const poster: Image = { mediaType: r.mediaType as Image["mediaType"], base64: r.base64, label: "Image 1: the poster." };
    const checkImages: Image[] = [
      poster,
      ...(x.logo ? [{ ...x.logo, label: "Image 2: the brand's real logo." }] : [{ ...poster, label: "Image 2: no logo file was given; ignore this image and answer logo: missing." }]),
      ...(x.photo ? [{ ...x.photo, label: "Image 3: the owner's photo." }] : []),
    ];
    const read = await guardedCall(deps, "read_back", { ...rb, images: checkImages }, PosterReadSchema);
    verdict = judgePoster(read.data, copyList, { photoGiven: Boolean(x.photo), logoGiven: Boolean(x.logo) });
    const attempt = { n, pass: verdict.pass, problems: verdict.problems.slice(0, 12).map((p) => p.slice(0, 300)), model: r.model, seconds: r.seconds };
    if (verdict.pass) {
      await set((j) => ({ ...j, status: "done", stage: "Done", attempts: [...j.attempts, attempt], result: { attempt: n, mediaType: r.mediaType } }));
      return;
    }
    await set((j) => ({ ...j, attempts: [...j.attempts, attempt] }));
  }
  // Both paintings failed a check: the browser builds the B version instead (painted plate, real type).
  await set((j) => ({ ...j, status: "fallback", stage: "Building the backup version" }));
}
