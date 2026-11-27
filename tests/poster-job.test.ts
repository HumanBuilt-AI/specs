// The poster job: one per visit, painted in the background, read back and judged in code, one
// repaint told what failed, then the B fallback. Painter and Claude are fakes, so nothing is spent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { respond } from "../server/http.ts";
import { startSession, createPost, writePost } from "../server/handlers.ts";
import { startPoster, posterStatus, posterImage, posterPlate, type PosterTrigger } from "../server/poster.ts";
import { runPoster, type Paint } from "../server/poster-run.ts";
import { todaysSpend } from "../server/spend.ts";
import type { Deps } from "../server/handlers.ts";
import type { PosterRead } from "../core/poster.ts";
import { makeDeps, jsonReq, body, brief, COMPOSED } from "./helpers.ts";

const run = (fn: () => Promise<Response>) => respond(fn);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 7)]).toString("base64");

/** Every quoted line of the copy the read-back prompt was given, as the poster's text. */
const copyFrom = (user: string) => [...user.matchAll(/^\w+: "(.*)" \(\d+ characters\)$/gm)].map((m) => m[1]!);

async function setup(opts: { reads?: ((copy: string[]) => Partial<PosterRead>)[]; paintFails?: boolean } = {}) {
  const made = makeDeps();
  const base = made.deps.callStep;
  const steps: string[] = [];
  const paintPrompts: string[] = [];
  let reads = 0;
  const deps: Deps = { ...made.deps };
  deps.callStep = async (o) => {
    steps.push(o.step);
    if (o.step === "read_back") {
      const copy = copyFrom(o.user);
      const tweak = opts.reads?.[reads++]?.(copy) ?? {};
      const data: PosterRead = { text: copy, logo_text: [], logo: "same", logo_count: 1, logo_notes: "", photo: (o.images?.length ?? 0) === 3 ? "same" : "none_given", photo_notes: "", hard_to_read: [], ...tweak };
      return { data: data as never, usage: { step: o.step, model: "claude-sonnet-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.02 } };
    }
    if (o.step === "compose_print") return { data: { ...COMPOSED, rationale: [...COMPOSED.rationale, { decision: "art zones", choice: "A big record lower right.", reason: "Room for type top left.", cites: [] }] } as never, usage: { step: o.step, model: "claude-sonnet-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.1 } };
    return base(o);
  };
  const paint: Paint = async (o) => {
    paintPrompts.push(o.text);
    if (opts.paintFails) return { ok: false, error: "500 from the painter", billed: false, model: "gpt-image-2.5-sunburst" } as never;
    return { ok: true, base64: PNG, mediaType: "image/png", model: "gpt-image-2.5-sunburst", usd: 0.2, seconds: 40 } as never;
  };
  const s = await body(await run(() => startSession(jsonReq("/api/session", { turnstileToken: "good-token" }), deps)));
  const sessionId = s.sessionId as string;
  const p = await body(await run(() => createPost(jsonReq("/api/posts", { sessionId, brand: "half-acre-club", intent: "promo", brief }), deps)));
  const postId = p.postId as string;
  await run(() => writePost(jsonReq("/api/posts/write", { sessionId, postId }), deps));
  const triggers: PosterTrigger[] = [];
  const starter = async (t: PosterTrigger) => {
    triggers.push(t);
    await runPoster(deps, t, "test-key", paint);
  };
  const status = async () => body(await run(() => posterStatus(jsonReq("/api/posters/status", { sessionId, postId }), deps)));
  const start = () => run(() => startPoster(jsonReq("/api/posters/start", { sessionId, postId }), deps, starter, true));
  return { deps, sessionId, postId, steps, paintPrompts, triggers, starter, paint, status, start };
}

test("a poster that passes the read-back is done on the first paint, and only it is served", async () => {
  const { deps, sessionId, postId, steps, paintPrompts, start, status } = await setup();
  const started = await start();
  assert.equal(started.status, 202);
  assert.equal((await body(started)).token, undefined, "the token never reaches the browser");
  const job = await status();
  assert.equal(job.status, "done");
  assert.deepEqual((job.attempts as { pass: boolean }[]).map((a) => a.pass), [true]);
  assert.equal(steps.filter((s) => s === "read_back").length, 1);
  assert.equal(paintPrompts.length, 1);
  assert.match(paintPrompts[0]!, /The brand's real logo/);
  assert.match(paintPrompts[0]!, /This take: your best version/);
  const img = await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId }), deps));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).toString("base64"), PNG);
  // Spend: the painting and the read-back both count against the day.
  const spent = await todaysSpend(deps.kv, deps.now());
  assert.ok(spent.spentUsd >= 0.22, `spent ${spent.spentUsd}`);
});

test("a failed check gets one repaint told what failed", async () => {
  const { start, status, paintPrompts } = await setup({ reads: [(copy) => ({ text: [...copy, "Free entry"] })] });
  await start();
  const job = await status();
  assert.equal(job.status, "done");
  const attempts = job.attempts as { n: number; pass: boolean; problems: string[] }[];
  assert.deepEqual(attempts.map((a) => a.pass), [false, true]);
  assert.match(attempts[0]!.problems.join(), /"free" is painted but isn't in the copy/);
  assert.equal(paintPrompts.length, 2);
  assert.match(paintPrompts[1]!, /The last painting failed these checks/);
  assert.match(paintPrompts[1]!, /"entry" is painted/);
});

test("two failed checks build the B fallback, and the failed paintings are never served", async () => {
  const redrawn = () => ({ logo: "redrawn" as const, logo_notes: "Letters respaced." });
  const { deps, sessionId, postId, start, status, steps, paintPrompts } = await setup({ reads: [redrawn, redrawn] });
  await start();
  const job = await status();
  assert.equal(job.status, "b_ready", String(job.error));
  assert.equal((job.attempts as unknown[]).length, 2);
  assert.equal(job.result, undefined);
  assert.equal((await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId }), deps))).status, 404, "a painting that failed is never served");
  // B: a type layer checked in code, then a text-free plate painted around its art zones.
  assert.ok(steps.includes("compose_print"));
  assert.equal(paintPrompts.length, 3);
  assert.match(paintPrompts[2]!, /A big record lower right/);
  assert.match(paintPrompts[2]!, /no text at all/);
  const b = job.b as { html: string; usesPhoto: boolean };
  assert.match(b.html, /data-slot="headline"/);
  const plate = await run(() => posterPlate(jsonReq("/api/posters/plate", { sessionId, postId }), deps));
  assert.equal(plate.status, 200);
  assert.equal(plate.headers.get("content-type"), "image/png");
});

test("one poster per visit, a repeated trigger spends nothing, and a painter error fails the job", async () => {
  const a = await setup();
  await a.start();
  assert.equal((await a.start()).status, 200, "starting again returns the same job");
  // Netlify retries a background run: the job is already claimed, so nothing paints again.
  await runPoster(a.deps, a.triggers[0]!, "test-key", a.paint);
  assert.equal(a.paintPrompts.length, 1);
  // A forged token does nothing.
  await runPoster(a.deps, { ...a.triggers[0]!, token: "nope" }, "test-key", a.paint);
  assert.equal(a.paintPrompts.length, 1);

  const b = await setup({ paintFails: true });
  await b.start();
  const job = await b.status();
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /didn't paint/);
});

test("posters refuse to start without the painter's key", async () => {
  const { deps, sessionId, postId, starter } = await setup();
  const r = await run(() => startPoster(jsonReq("/api/posters/start", { sessionId, postId }), deps, starter, false));
  assert.equal(r.status, 503);
});
