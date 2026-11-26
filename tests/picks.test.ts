// The upload steps (Nov 26): hero photos, a palette by role and fonts, set before anything is
// read. Pure palette logic, the kit reading a palette by role, and the endpoint end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { respond } from "../server/http.ts";
import { savePicks, startSession, upload, type Deps } from "../server/handlers.ts";
import { assemble, readUpload } from "../server/extract.ts";
import { EXTRACT_CHUNKS } from "../core/extract.ts";
import { findGaps, type IntakeChunks } from "../core/intake.ts";
import { triage } from "../core/triage.ts";
import { kitFromChunks } from "../core/session-kit.ts";
import { PICKS_SOURCE, deltaE, guessPurpose, paletteCandidates, paletteText, suggestPalette, typedHexes } from "../core/picks.ts";
import { makeDeps, jsonReq, formReq, body, DRAFT } from "./helpers.ts";

const run = (fn: () => Promise<Response>) => respond(fn);
const PLUM = "#361E39", RED = "#BE3042", CREAM = "#F4EBDD";
const sw = (hex: string, share: number) => ({ hex, share });

test("palette candidates: logo first, near-duplicate browns merged, specks left out", () => {
  const browns = ["#5A4030", "#5E4433", "#63473A", "#4F3A2C", "#6A4B36"];
  const cands = paletteCandidates([
    { kind: "image", colors: [...browns.map((h) => sw(h, 0.15)), sw("#2F6FD0", 0.01)] },
    { kind: "logo", colors: [sw(PLUM, 0.5), sw(RED, 0.2), sw(CREAM, 0.3)] },
  ]);
  assert.deepEqual(cands.slice(0, 3).map((c) => c.hex), [PLUM, RED, CREAM], "the logo's colors lead");
  const fromPhotos = cands.filter((c) => c.from === "photo");
  assert.ok(fromPhotos.length <= 2, `five browns became ${fromPhotos.length}`);
  assert.ok(!cands.some((c) => c.hex === "#2F6FD0"), "a 1% speck isn't a brand color");
  for (const [i, a] of cands.entries()) for (const b of cands.slice(i + 1)) assert.ok(deltaE(a.hex, b.hex) >= 14);
});

test("palette candidates: hex codes the owner pasted come first", () => {
  const cands = paletteCandidates([{ kind: "logo", colors: [sw("#361e3a", 0.6)] }], typedHexes("plum #361E39 and red #be3042"));
  assert.deepEqual(cands.map((c) => [c.hex, c.from]), [[PLUM, "typed"], [RED, "typed"]], "the logo's near-identical plum merges into the typed one");
});

test("suggested palette: a brand light or dark behind, readable text, the loudest brand color as accent", () => {
  const p = suggestPalette(paletteCandidates([{ kind: "logo", colors: [sw(PLUM, 0.5), sw(RED, 0.2), sw(CREAM, 0.3)] }, { kind: "image", colors: [sw("#5A4030", 0.6)] }]));
  const role = (r: string) => p.find((x) => x.role === r)?.hex;
  assert.equal(role("background"), PLUM);
  assert.equal(role("text"), CREAM);
  assert.equal(role("accent"), RED);
});

test("a palette set by role reaches the posts' colors exactly", () => {
  const chunks: IntakeChunks = {
    "visual-system": {
      draft: {
        summary: "",
        confidence: "high",
        missing: [],
        items: [
          { label: "palette", value: paletteText([{ role: "background", hex: PLUM }, { role: "text", hex: CREAM }, { role: "headings", hex: "#F7D9A8" }, { role: "accent", hex: RED }, { role: "extra", hex: "#E8B931" }]), why: null, sources: [{ ...PICKS_SOURCE }], confidence: "high" },
          { label: "fonts", value: "Fonts: Fraunces for headings, Plus Jakarta Sans for body text", why: null, sources: [{ ...PICKS_SOURCE }], confidence: "high" },
        ],
      },
    },
  };
  const kit = kitFromChunks(chunks, { name: "Good Company" });
  assert.equal(kit.colors.background, PLUM);
  assert.equal(kit.colors.text, CREAM);
  assert.equal(kit.colors.heading, "#F7D9A8");
  assert.equal(kit.colors.headingPinned, true);
  assert.equal(kit.colors.accent, RED);
  assert.equal(kit.colors.accent2, "#E8B931");
  assert.equal(kit.fonts.heading, "Fraunces");
  assert.equal(kit.fonts.body, "Plus Jakarta Sans");
});

test("text files: prompts for an image tool start as Leave out", () => {
  assert.equal(guessPurpose("image-prompts.txt"), "skip");
  assert.equal(guessPurpose("generation-notes.txt"), "skip");
  assert.equal(guessPurpose("brand-voice.md"), "voice");
  assert.equal(guessPurpose("contact.txt"), "facts");
  assert.equal(guessPurpose("brand.json"), "facts");
});

test("triage never asks again about what the owner set up front", () => {
  const chunks: IntakeChunks = Object.fromEntries(EXTRACT_CHUNKS.map((c) => [c.id, { draft: structuredClone(DRAFT) }]));
  const vs = chunks["visual-system"]!.draft;
  // A doubtful color item sits beside the owner's palette.
  vs.items = [{ label: "palette", value: paletteText([{ role: "background", hex: PLUM }, { role: "text", hex: CREAM }]), why: null, sources: [{ ...PICKS_SOURCE }], confidence: "high" }, { label: "color: accent", value: "#123456", why: null, sources: [{ upload: "a.pdf", location: "p1" }], confidence: "needs-review" }];
  const gaps = findGaps(chunks, {});
  const plan = triage(gaps, chunks);
  const paletteGaps = gaps.filter((g) => g.chunk === "visual-system" && /color|palette/.test(g.item?.label ?? g.slot ?? ""));
  assert.ok(paletteGaps.length > 0);
  for (const g of paletteGaps) assert.ok(plan.skip.includes(g.id) && !plan.ask.includes(g.id), `${g.id} isn't asked`);
});

test("picks endpoint: saved before drafting, lead their chunk, and are refused once drafting starts", async () => {
  const { deps, sent } = makeDeps();
  const sid = ((await body(await run(() => startSession(jsonReq("/api/session", { turnstileToken: "good-token" }), deps)))) as { sessionId: string }).sessionId;
  const add = async (fields: Record<string, string | Blob>) => ((await body(await run(() => upload(formReq({ sessionId: sid, ...fields }), deps)))) as { upload: { id: string } }).upload.id;
  const pick = (picks: unknown, d: Deps = deps) => run(() => savePicks(jsonReq("/api/session/picks", { sessionId: sid, picks }), d));

  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
  const photo = await add({ kind: "image", file: new File([JPEG], "storefront.jpg") });
  const note = await add({ kind: "note", text: "Record shop in the North Loop." });
  const voice = await add({ kind: "doc", file: new File(["Find a record. Stay for the company."], "voice.txt"), purpose: "voice" });

  assert.equal((await pick({ heroes: [photo] })).status, 200);
  assert.equal((await pick({ palette: [{ role: "background", hex: PLUM }, { role: "text", hex: CREAM }, { role: "accent", hex: RED }] })).status, 200);
  const saved = (await body(await pick({ fonts: { heading: "Fraunces", body: "Plus Jakarta Sans" } }))) as { picks: Record<string, unknown> };
  assert.ok(saved.picks.heroes && saved.picks.palette && saved.picks.fonts, "each step's part is merged in");
  assert.equal((await pick({ heroes: [note] })).status, 400, "only a photo can be a hero");
  assert.equal((await pick({ palette: [{ role: "background", hex: "plum" }] })).status, 400);

  for (const id of [photo, note, voice]) assert.equal((await run(() => readUpload(jsonReq("/api/extract/read", { sessionId: sid, uploadId: id }), deps))).status, 200);
  const voiceRead = sent.find((c) => c.step === "read" && c.user.includes("voice.txt"))!;
  assert.ok(voiceRead.user.includes("marked this file as voice"), "the read step is told what the file is for");

  const res = await run(() => assemble(jsonReq("/api/extract/assemble", { sessionId: sid, target: "visual-system" }), deps));
  const rec = (await body(res)) as { draft: { items: unknown[] } };
  assert.equal(res.status, 200, JSON.stringify(rec));
  const items = rec.draft.items as { label: string; value: string; sources: { upload: string }[] }[];
  assert.equal(items[0]!.label, "palette");
  assert.match(items[0]!.value, /background #361E39, text #F4EBDD, accent #BE3042/);
  assert.equal(items[1]!.value, "Fonts: Fraunces for headings, Plus Jakarta Sans for body text");
  assert.ok(!items.some((i) => i.label.startsWith("color")), "the model's own color guesses give way to the owner's palette");
  assert.ok(sent.at(-1)!.cachedText?.includes("The owner set the brand palette by role"), "the drafting step sees the picks as evidence");

  const art = (await body(await run(() => assemble(jsonReq("/api/extract/assemble", { sessionId: sid, target: "art-direction" }), deps)))) as { draft: { items: { value: string }[] } };
  assert.equal(art.draft.items[0]!.value, "Hero photos: storefront.jpg");

  assert.equal((await pick({ fonts: { heading: "Inter", body: "Inter" } })).status, 409, "after drafting starts, the chat changes the kit instead");
});
