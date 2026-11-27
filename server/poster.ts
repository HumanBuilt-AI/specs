// Posters (plan "Specs: posters in the app", Nov 27): after a post is written, the owner can ask
// for a poster once per visit. The image model paints the whole poster from the kit, the post's
// copy, the owner's photo and logo; Claude reads every word back and code judges it
// (core/poster.ts). A failed check gets one repaint told what failed; a second fail ends in
// "fallback", where the browser builds B (a painted plate with real type on top) instead.
// Painting takes minutes, so it runs in a background function, and the browser follows it:
//
//   POST /api/posters/start   claims the session's one poster and starts the painting
//   POST /api/posters/status  the job as it stands (stage, attempts, result)
//   POST /api/posters/image   the finished poster's image bytes
//   POST /api/posters/plate   the B version's painted plate (text-free art the browser sets type over)
//
// The background run (server/poster-run.ts) checks a per-job token before doing anything, so only
// a job this file started can spend money, and every call is reserved against the daily cap first.
import "server-only";
import { z } from "zod";
import { LIMITS } from "../core/limits.ts";
import { OUTPUT_FORMATS, type OutputFormat } from "../core/outputs.ts";
import { Refusal, json, readJson } from "./http.ts";
import { assertGenerationOpen } from "./spend.ts";
import { loadSession, updateSession } from "./sessions.ts";
import { parseBody, id, type Deps } from "./handlers.ts";
import { update, type KV } from "./store.ts";

export type PosterAttempt = {
  /** 1 the quick first look, 2 the final, 3 the final's repaint. */
  n: number;
  quality?: "low" | "high";
  pass: boolean;
  /** Plain sentences from core/poster.ts, for the repaint and the owner's notes. Empty on a pass. */
  problems: string[];
  /** On a repaint: what it fixed, what it left, and anything it broke, against the painting it repaired. */
  repair?: { fixed: string[]; unresolved: string[]; introduced: string[] };
  model: string;
  seconds: number;
};

export type PosterJob = {
  /** painting → checking → (painting → checking) → done, or after two failed checks fallback → b_ready; failed on an error */
  status: "painting" | "checking" | "done" | "fallback" | "b_ready" | "failed";
  /** Shared only with the background function, never sent to the browser. */
  token: string;
  startedAt: string;
  updatedAt: string;
  /** What's happening now, in a few words, for the working line. */
  stage: string;
  ran: boolean;
  attempts: PosterAttempt[];
  /** Which output (core/outputs.ts). Older jobs have none and paint the post's own canvas. */
  format?: OutputFormat;
  /** The quick take, once it passed every check: shown while the final is still painting. */
  firstLook?: { attempt: number; mediaType: string };
  /** Set when a painting passed every check. */
  result?: { attempt: number; mediaType: string };
  /** The B version (painted plate, real type set by code), when both paintings failed a check. */
  b?: { html: string; css: string; usesPhoto: boolean; rationale: { decision: string; choice: string; reason: string; cites: string[] }[]; plateMediaType: string };
  error?: string;
};

export type PosterTrigger = { sessionId: string; postId: string; token: string };
/** Starts the background run. Live: a request to the background function. Tests and local dev: in-process. */
export type StartPosterBackground = (t: PosterTrigger) => Promise<void>;

export const posterKey = (sessionId: string, postId: string) => `poster/${sessionId}/${postId}`;
export const posterImageKey = (sessionId: string, postId: string, n: number) => `poster/${sessionId}/${postId}/paint/${n}`;
export const posterPlateKey = (sessionId: string, postId: string) => `poster/${sessionId}/${postId}/plate`;

const PostBody = z.strictObject({ sessionId: id, postId: id });
const StartBody = z.strictObject({ sessionId: id, postId: id, format: z.enum(OUTPUT_FORMATS).optional() });
const ImageBody = z.strictObject({ sessionId: id, postId: id, which: z.enum(["final", "first"]).optional() });

export async function loadPosterJob(kv: KV, sessionId: string, postId: string) {
  return (await kv.get<PosterJob>(posterKey(sessionId, postId)))?.value ?? null;
}

export function updatePosterJob(kv: KV, sessionId: string, postId: string, change: (j: PosterJob) => PosterJob) {
  return update<PosterJob>(kv, posterKey(sessionId, postId), () => {
    throw new Refusal(404, "no_poster", "This post has no poster in the works.");
  }, (j) => ({ ...change(j), updatedAt: new Date().toISOString() }));
}

/** What the browser sees: no token. */
export function posterView(j: PosterJob) {
  const { token: _token, ...rest } = j;
  return rest;
}

export async function startPoster(req: Request, deps: Deps, startBackground: StartPosterBackground, painterReady: boolean) {
  const body = parseBody(StartBody, await readJson(req, LIMITS.jsonBodyBytes));
  const now = deps.now();
  if (!painterReady) throw new Refusal(503, "posters_off", "Posters aren't set up on this server yet.");
  await assertGenerationOpen(deps.kv, deps.settings, now);
  const session = await loadSession(deps.kv, body.sessionId, now);
  const post = session.posts[body.postId];
  if (!post) throw new Refusal(404, "no_post", "There's no such post in this session.");
  if (post.status !== "written") throw new Refusal(409, "not_ready", `This post can't become a poster yet (it's ${post.status}).`);
  // A job that failed gave the visit its poster back, so it can be started again.
  const found = await deps.kv.get<PosterJob>(posterKey(body.sessionId, body.postId));
  const existing = found?.value ?? null;
  if (existing && existing.status !== "failed") return json(posterView(existing));

  // Claim the session's one poster before any work, so two tabs can't both take it.
  await updateSession(deps.kv, body.sessionId, (s) => {
    const used = s.postersUsed ?? 0;
    if (used >= LIMITS.postersPerSession) throw new Refusal(429, "poster_cap", `Each visit gets ${LIMITS.postersPerSession} painted outputs, and they've been used.`);
    return { ...s, postersUsed: used + 1 };
  });
  const job: PosterJob = { status: "painting", token: crypto.randomUUID(), startedAt: now.toISOString(), updatedAt: now.toISOString(), stage: "Painting a first look", ran: false, attempts: [], ...(body.format ? { format: body.format } : {}) };
  const stored = found ? await deps.kv.put(posterKey(body.sessionId, body.postId), job, { ifMatch: found.etag }) : await deps.kv.put(posterKey(body.sessionId, body.postId), job, { ifNew: true });
  if (!stored) {
    await updateSession(deps.kv, body.sessionId, (s) => ({ ...s, postersUsed: Math.max(0, (s.postersUsed ?? 1) - 1) }));
    const j = await loadPosterJob(deps.kv, body.sessionId, body.postId);
    return json(j ? posterView(j) : null);
  }
  try {
    await startBackground({ sessionId: body.sessionId, postId: body.postId, token: job.token });
  } catch (err) {
    // Nothing ran, so the visit keeps its poster.
    await deps.kv.put(posterKey(body.sessionId, body.postId), { ...job, status: "failed", error: "start_failed" }, { ifMatch: (await deps.kv.get(posterKey(body.sessionId, body.postId)))!.etag });
    await updateSession(deps.kv, body.sessionId, (s) => ({ ...s, postersUsed: Math.max(0, (s.postersUsed ?? 1) - 1) }));
    console.error("Poster didn't start:", err instanceof Error ? err.message : String(err));
    throw new Refusal(503, "poster_unavailable", "The poster couldn't start. Try again in a minute.");
  }
  return json(posterView(job), 202);
}

export async function posterStatus(req: Request, deps: Deps) {
  const body = parseBody(PostBody, await readJson(req, LIMITS.jsonBodyBytes));
  await loadSession(deps.kv, body.sessionId, deps.now());
  const job = await loadPosterJob(deps.kv, body.sessionId, body.postId);
  if (!job) throw new Refusal(404, "no_poster", "This post has no poster in the works.");
  return json(posterView(job));
}

/** The finished poster's bytes, or the first look's. Only a painting that passed every check is ever served. */
export async function posterImage(req: Request, deps: Deps) {
  const body = parseBody(ImageBody, await readJson(req, LIMITS.jsonBodyBytes));
  await loadSession(deps.kv, body.sessionId, deps.now());
  const job = await loadPosterJob(deps.kv, body.sessionId, body.postId);
  const pick = body.which === "first" ? job?.firstLook : job?.status === "done" ? job.result : undefined;
  if (!pick) throw new Refusal(404, "no_poster", "This post has no finished poster.");
  const bytes = await deps.kv.getBytes(posterImageKey(body.sessionId, body.postId, pick.attempt));
  if (!bytes) throw new Refusal(404, "no_poster", "This post has no finished poster.");
  return new Response(bytes, { status: 200, headers: { "content-type": pick.mediaType, "cache-control": "private, max-age=3600" } });
}

/** The B version's plate: text-free art, so it needs no read-back; the browser sets the real type over it. */
export async function posterPlate(req: Request, deps: Deps) {
  const body = parseBody(PostBody, await readJson(req, LIMITS.jsonBodyBytes));
  await loadSession(deps.kv, body.sessionId, deps.now());
  const job = await loadPosterJob(deps.kv, body.sessionId, body.postId);
  if (!job?.b || job.status !== "b_ready") throw new Refusal(404, "no_plate", "This poster has no backup version.");
  const bytes = await deps.kv.getBytes(posterPlateKey(body.sessionId, body.postId));
  if (!bytes) throw new Refusal(404, "no_plate", "This poster has no backup version.");
  return new Response(bytes, { status: 200, headers: { "content-type": job.b.plateMediaType, "cache-control": "private, max-age=3600" } });
}
