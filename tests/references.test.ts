// References: the Cosmos link reader (core, pure) and the routes that keep up to five images and
// the sliders (server, with a fake fetch so no network is touched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { respond } from "../server/http.ts";
import { startSession } from "../server/handlers.ts";
import { addCosmosBoard, addReferenceImage, referenceImages, removeReference, saveReferenceSettings } from "../server/references.ts";
import { loadSession } from "../server/sessions.ts";
import { cosmosImageLinks, cosmosUrl, isCosmosImageHost, referencesChunk, sliderWords, DEFAULT_SLIDERS } from "../core/references.ts";
import { makeDeps, jsonReq, formReq, body } from "./helpers.ts";

const run = (fn: () => Promise<Response>) => respond(fn);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(7)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(200).fill(3)]);

async function session() {
  const made = makeDeps();
  const s = await body(await run(() => startSession(jsonReq("/api/session", { turnstileToken: "good-token" }), made.deps)));
  return { deps: made.deps, sessionId: s.sessionId as string };
}

test("only https cosmos.so pages count as board links", () => {
  assert.ok(cosmosUrl("https://www.cosmos.so/someone/posters"));
  assert.ok(cosmosUrl("  https://cosmos.so/e/123 "));
  assert.equal(cosmosUrl("http://www.cosmos.so/someone/posters"), null);
  assert.equal(cosmosUrl("https://cosmos.so.evil.com/x"), null);
  assert.equal(cosmosUrl("https://user:pw@cosmos.so/x"), null);
  assert.equal(cosmosUrl("https://cosmos.so:8443/x"), null);
  assert.equal(cosmosUrl("not a link"), null);
  assert.ok(isCosmosImageHost("https://cdn.cosmos.so/abc"));
  assert.equal(isCosmosImageHost("https://evilcosmos.so/abc"), false);
  assert.equal(isCosmosImageHost("https://169.254.169.254/latest"), false);
});

test("board pages give their image links, best first, without avatars or repeats", () => {
  const html = `<meta property="og:image" content="https://cdn.cosmos.so/og-1.jpg?w=1200">
    <img src="https://cdn.cosmos.so/avatar/me.jpg"><img src="https://cdn.cosmos.so/og-1.jpg?w=400">
    <script>{"url":"https:\\/\\/cdn.cosmos.so\\/a7f3e"}, "x":"https://other.com/p.jpg", "y":"https://www.cosmos.so/about"</script>`;
  assert.deepEqual(cosmosImageLinks(html), ["https://cdn.cosmos.so/og-1.jpg?w=1200", "https://cdn.cosmos.so/a7f3e"]);
});

test("the references chunk names the sliders and never asks to copy", () => {
  const chunk = referencesChunk({ images: [{ id: "a", mediaType: "image/png", from: "cosmos" }], sliders: { density: 1, contrast: 5, texture: 3 }, board: "https://www.cosmos.so/x" });
  assert.match(chunk, /^---\nchunk_id: references/);
  assert.match(chunk, /Density 1 of 5: very airy/);
  assert.match(chunk, /Contrast 5 of 5: punchy/);
  assert.match(chunk, /Never copy their words, logos/);
  assert.equal(sliderWords(DEFAULT_SLIDERS).length, 3);
});

test("reference images are kept up to five, and gifs are refused", async () => {
  const { deps, sessionId } = await session();
  for (let i = 0; i < 5; i++) {
    const r = await run(() => addReferenceImage(formReq({ sessionId, file: new File([PNG], `r${i}.png`, { type: "image/png" }) }), deps));
    assert.equal(r.status, 200);
  }
  const sixth = await run(() => addReferenceImage(formReq({ sessionId, file: new File([PNG], "r6.png", { type: "image/png" }) }), deps));
  assert.equal((await body(sixth)).error?.code, "references_full");
  const s = await loadSession(deps.kv, sessionId, deps.now());
  assert.equal((await referenceImages(deps, s)).length, 5);

  const gif = await run(() => addReferenceImage(formReq({ sessionId, file: new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 1, 2])], "a.gif") }), deps));
  assert.equal(gif.status, 415);

  const id = s.references!.images[0]!.id;
  const after = await body(await run(() => removeReference(jsonReq("/api/references/remove", { sessionId, id }), deps)));
  assert.equal((after.references as { images: unknown[] }).images.length, 4);
});

test("sliders save, and a call without them reads back what's saved", async () => {
  const { deps, sessionId } = await session();
  await run(() => saveReferenceSettings(jsonReq("/api/references/settings", { sessionId, sliders: { density: 2, contrast: 4, texture: 5 } }), deps));
  const r = await body(await run(() => saveReferenceSettings(jsonReq("/api/references/settings", { sessionId }), deps)));
  assert.deepEqual((r.references as { sliders: unknown }).sliders, { density: 2, contrast: 4, texture: 5 });
  const bad = await run(() => saveReferenceSettings(jsonReq("/api/references/settings", { sessionId, sliders: { density: 9, contrast: 4, texture: 5 } }), deps));
  assert.equal(bad.status, 400);
});

test("a Cosmos board is read through a fake fetch that only reaches cosmos hosts", async () => {
  const { deps, sessionId } = await session();
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    if (url === "https://www.cosmos.so/me/posters") {
      return new Response(`<meta property="og:image" content="https://cdn.cosmos.so/one.jpg"><img src="https://cdn.cosmos.so/two"><img src="https://cdn.cosmos.so/hop">`, { status: 200 });
    }
    if (url === "https://cdn.cosmos.so/one.jpg") return new Response(JPEG, { status: 200 });
    if (url === "https://cdn.cosmos.so/two") return new Response("<html>not an image</html>", { status: 200 });
    // A redirect off cosmos is never followed.
    if (url === "https://cdn.cosmos.so/hop") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const r = await body(await run(() => addCosmosBoard(jsonReq("/api/references/cosmos", { sessionId, url: "https://www.cosmos.so/me/posters" }), deps, fake)));
  assert.equal(r.kept, 1);
  assert.ok(!asked.some((u) => u.includes("169.254")));
  const s = await loadSession(deps.kv, sessionId, deps.now());
  assert.equal(s.references?.board, "https://www.cosmos.so/me/posters");
  assert.equal(s.references?.images[0]?.mediaType, "image/jpeg");

  const notCosmos = await run(() => addCosmosBoard(jsonReq("/api/references/cosmos", { sessionId, url: "https://pinterest.com/me" }), deps, fake));
  assert.equal((await body(notCosmos)).error?.code, "not_cosmos");
  const empty = await run(() => addCosmosBoard(jsonReq("/api/references/cosmos", { sessionId, url: "https://www.cosmos.so/private" }), deps, fake));
  assert.equal((await body(empty)).error?.code, "cosmos_unreadable");
});
