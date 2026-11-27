// The painted-output job: a quick first look and the final painted side by side in the background,
// each read back and judged in code, one repaint of the final told what failed, then the B fallback.
// Painter and Claude are fakes, so nothing is spent.
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

type Take = "quick" | "final" | "repaint";
/** Which take a painting prompt asked for. */
const takeOf = (prompt: string): Take => (/The last painting failed/.test(prompt) ? "repaint" : /a quick first look/.test(prompt) ? "quick" : "final");
/** Each fake painting is a PNG that ends with its take's name, so the fake read-back knows which it reads. */
const pngFor = (t: Take) => Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from(t)]).toString("base64");
const takeIn = (base64: string): Take => (Buffer.from(base64, "base64").toString("latin1").match(/(quick|final|repaint)$/)?.[1] as Take) ?? "final";

async function setup(opts: { reads?: Partial<Record<Take, (copy: string[]) => Partial<PosterRead>>>; paintFails?: boolean; format?: "poster" | "story" | "square" } = {}) {
  const made = makeDeps();
  const base = made.deps.callStep;
  const steps: string[] = [];
  const paintPrompts: string[] = [];
  const deps: Deps = { ...made.deps };
  deps.callStep = async (o) => {
    steps.push(o.step);
    if (o.step === "read_back") {
      const copy = copyFrom(o.user);
      const tweak = opts.reads?.[takeIn(o.images![0]!.base64)]?.(copy) ?? {};
      const data: PosterRead = { text: copy, photo_text: [], logo_text: [], logo: "missing", logo_count: 0, logo_notes: "", logo_spot_clear: true, photo: (o.images?.length ?? 0) === 3 ? "same" : "none_given", photo_notes: "", hard_to_read: [], ...tweak };
      return { data: data as never, usage: { step: o.step, model: "claude-sonnet-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.02 } };
    }
    if (o.step === "compose_print") return { data: { ...COMPOSED, rationale: [...COMPOSED.rationale, { decision: "art zones", choice: "A big record lower right.", reason: "Room for type top left.", cites: [] }] } as never, usage: { step: o.step, model: "claude-sonnet-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.1 } };
    return base(o);
  };
  const paint: Paint = async (o) => {
    paintPrompts.push(o.text);
    if (opts.paintFails) return { ok: false, error: "500 from the painter", billed: false, model: "gpt-image-2.5-sunburst" } as never;
    return { ok: true, base64: pngFor(takeOf(o.text)), mediaType: "image/png", model: "gpt-image-2.5-sunburst", usd: 0.2, seconds: 40 } as never;
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
  const start = () => run(() => startPoster(jsonReq("/api/posters/start", { sessionId, postId, ...(opts.format ? { format: opts.format } : {}) }), deps, starter, true));
  return { deps, sessionId, postId, steps, paintPrompts, triggers, starter, paint, status, start };
}

test("the quick take and the final paint side by side, and the final that passes is served", async () => {
  const { deps, sessionId, postId, steps, paintPrompts, start, status } = await setup({ format: "story" });
  const started = await start();
  assert.equal(started.status, 202);
  assert.equal((await body(started)).token, undefined, "the token never reaches the browser");
  const job = await status();
  assert.equal(job.status, "done");
  assert.equal(job.format, "story");
  assert.deepEqual((job.attempts as { n: number; pass: boolean }[]).map((a) => a.pass), [true, true]);
  assert.deepEqual(job.result, { attempt: 2, mediaType: "image/png" }, "the final wins");
  assert.equal(steps.filter((s) => s === "read_back").length, 2);
  assert.equal(paintPrompts.length, 2);
  // The painter never gets the logo, and is told which side strips a story trims off.
  for (const p of paintPrompts) {
    assert.match(p, /The logo file is kept back for code to place/);
    assert.match(p, /The logo spot: the top-left corner, from 8% across/);
    assert.match(p, /The outer 8% of the width on each side is trimmed off/);
  }
  const img = await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId }), deps));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).toString("base64"), pngFor("final"));
  const first = await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId, which: "first" }), deps));
  assert.equal(Buffer.from(await first.arrayBuffer()).toString("base64"), pngFor("quick"), "the first look is kept too");
  // Spend: both paintings and both read-backs count against the day.
  const spent = await todaysSpend(deps.kv, deps.now());
  assert.ok(spent.spentUsd >= 0.44, `spent ${spent.spentUsd}`);
});

test("a final that fails gets one repaint told what failed", async () => {
  const { start, status, paintPrompts } = await setup({ reads: { final: (copy) => ({ text: [...copy, "Free entry"] }) } });
  await start();
  const job = await status();
  assert.equal(job.status, "done");
  const attempts = job.attempts as { n: number; pass: boolean; problems: string[] }[];
  assert.deepEqual(attempts.find((a) => a.n === 2)?.pass, false);
  assert.match(attempts.find((a) => a.n === 2)!.problems.join(), /"free" is painted but isn't in the copy/);
  assert.deepEqual(job.result, { attempt: 3, mediaType: "image/png" });
  assert.equal(paintPrompts.length, 3);
  assert.match(paintPrompts[2]!, /The last painting failed these checks/);
  assert.match(paintPrompts[2]!, /"entry" is painted/);
});

test("when both finals fail, a first look that passed becomes the result", async () => {
  const painted = () => ({ logo: "redrawn" as const, logo_count: 1 });
  const { start, status } = await setup({ reads: { final: painted, repaint: painted } });
  await start();
  const job = await status();
  assert.equal(job.status, "done");
  assert.deepEqual(job.result, { attempt: 1, mediaType: "image/png" });
  assert.match((job.attempts as { problems: string[] }[]).flatMap((a) => a.problems).join(), /a logo is painted/);
});

test("when nothing passes, the square builds the B fallback, and the failed paintings are never served", async () => {
  const painted = () => ({ logo: "redrawn" as const, logo_count: 1 });
  const { deps, sessionId, postId, start, status, steps, paintPrompts } = await setup({ format: "square", reads: { quick: painted, final: painted, repaint: painted } });
  await start();
  const job = await status();
  assert.equal(job.status, "b_ready", String(job.error));
  assert.equal((job.attempts as unknown[]).length, 3);
  assert.equal(job.result, undefined);
  assert.equal(job.firstLook, undefined);
  assert.equal((await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId }), deps))).status, 404, "a painting that failed is never served");
  assert.equal((await run(() => posterImage(jsonReq("/api/posters/image", { sessionId, postId, which: "first" }), deps))).status, 404);
  // B: a type layer checked in code, then a text-free plate painted around its art zones.
  assert.ok(steps.includes("compose_print"));
  assert.equal(paintPrompts.length, 4);
  assert.match(paintPrompts[3]!, /A big record lower right/);
  assert.match(paintPrompts[3]!, /no text at all/);
  const b = job.b as { html: string; usesPhoto: boolean };
  assert.match(b.html, /data-slot="headline"/);
  const plate = await run(() => posterPlate(jsonReq("/api/posters/plate", { sessionId, postId }), deps));
  assert.equal(plate.status, 200);
  assert.equal(plate.headers.get("content-type"), "image/png");
});

test("when nothing passes on a tall output, the job fails and the visit gets its output back", async () => {
  const painted = () => ({ logo: "redrawn" as const, logo_count: 1 });
  const { start, status } = await setup({ format: "poster", reads: { quick: painted, final: painted, repaint: painted } });
  await start();
  const job = await status();
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /None of the paintings passed/);
  assert.equal((await start()).status, 202, "it can be started again");
});

test("one poster per visit, a repeated trigger spends nothing, and a painter error fails the job", async () => {
  const a = await setup();
  await a.start();
  assert.equal((await a.start()).status, 200, "starting again returns the same job");
  // Netlify retries a background run: the job is already claimed, so nothing paints again.
  await runPoster(a.deps, a.triggers[0]!, "test-key", a.paint);
  assert.equal(a.paintPrompts.length, 2);
  // A forged token does nothing.
  await runPoster(a.deps, { ...a.triggers[0]!, token: "nope" }, "test-key", a.paint);
  assert.equal(a.paintPrompts.length, 2);

  const b = await setup({ paintFails: true });
  await b.start();
  const job = await b.status();
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /didn't paint/);
  // Our failure gives the visit its poster back, so the owner can try again.
  const again = await b.start();
  assert.equal(again.status, 202, "a failed job can be started again");
  assert.equal(b.triggers.length, 2);
  assert.notEqual(b.triggers[0]!.token, b.triggers[1]!.token, "the retry gets a fresh token");
});

test("posters refuse to start without the painter's key", async () => {
  const { deps, sessionId, postId, starter } = await setup();
  const r = await run(() => startPoster(jsonReq("/api/posters/start", { sessionId, postId }), deps, starter, false));
  assert.equal(r.status, 503);
});
