// Posters painted whole by an image model: the code check that decides whether the owner sees one.
// Every model reply here is fake, so these cost nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePoster, logoRect, LOGO_SPOT, repaintNote, words, PosterReadSchema, type PosterRead } from "../core/poster.ts";
import { paintOpenAI } from "../core/image-openai.ts";
import { loadPrompt } from "../spike/lib/prompts.ts";

const COPY = [
  "Holiday Listening Party",
  "A night of music discovery, good drinks & great company.",
  "12/20/26 · 4:20PM – 10PM",
  "Alcoholic cocktails · Mocktails · Small food offerings",
];

const clean: PosterRead = {
  photo_text: [],
  logo_spot_clear: true,
  text: ["HOLIDAY", "LISTENING PARTY", "A night of music discovery, good drinks & great company.", "12/20/26 · 4:20PM - 10PM", "Alcoholic cocktails · Mocktails · Small food offerings"],
  logo_text: ["Good Company", "Records & CDs · Minneapolis"],
  logo: "same",
  logo_count: 1,
  logo_notes: "Matches.",
  photo: "same",
  photo_notes: "Taped print of the lounge photo, cropped.",
  hard_to_read: [],
};

test("a poster with every word, one real logo and the owner's photo passes", () => {
  const v = judgePoster(clean, COPY, { photoGiven: true });
  assert.equal(v.pass, true, v.problems.join("; "));
  assert.deepEqual(v.problems, []);
});

test("the logo's own small print never fails a poster (run 3's false fail)", () => {
  const v = judgePoster({ ...clean, hard_to_read: ["RECORDS & CDS · MINNEAPOLIS"] }, COPY, { photoGiven: true });
  assert.equal(v.pass, true, v.problems.join("; "));
  // Even when the reader forgets to list it as logo text, a line sharing no real word with the copy is not ours.
  const v2 = judgePoster({ ...clean, logo_text: ["Good Company"], hard_to_read: ["RECORDS & CDS · MINNEAPOLIS"] }, COPY, { photoGiven: true });
  assert.equal(v2.pass, true, v2.problems.join("; "));
});

test("hard-to-read copy from the brief still fails", () => {
  const v = judgePoster({ ...clean, hard_to_read: ["Small food offerings"] }, COPY, { photoGiven: true });
  assert.equal(v.pass, false);
  assert.deepEqual(v.hardToRead, ["Small food offerings"]);
});

test("invented and missing words fail, and the repaint is told which", () => {
  const v = judgePoster({ ...clean, text: [...clean.text.slice(0, 3), "Free entry", "Alcoholic cocktails · Mocktails"] }, COPY, { photoGiven: true });
  assert.equal(v.pass, false);
  assert.ok(v.invented.includes("free") && v.invented.includes("entry"));
  assert.ok(v.missing.includes("12/20/26") && v.missing.includes("offerings"));
  const note = repaintNote(v);
  assert.match(note, /"free" is painted but isn't in the copy/);
  assert.match(note, /"offerings" from the copy is missing/);
});

test("a redrawn or repeated logo fails", () => {
  assert.equal(judgePoster({ ...clean, logo: "redrawn", logo_notes: "Letters respaced." }, COPY, { photoGiven: true }).pass, false);
  const twice = judgePoster({ ...clean, logo_count: 2 }, COPY, { photoGiven: true });
  assert.equal(twice.pass, false);
  assert.match(twice.problems.join(), /appears 2 times/);
});

test("a repainted photo fails, so no invented people or shop pass as the owner's", () => {
  const v = judgePoster({ ...clean, photo: "changed", photo_notes: "Faces and the wall sign are repainted." }, COPY, { photoGiven: true });
  assert.equal(v.pass, false);
  assert.match(v.problems.join(), /photo is repainted or changed/);
  // With no owner photo given there is nothing to keep.
  assert.equal(judgePoster({ ...clean, photo: "none_given" }, COPY, { photoGiven: false }).pass, true);
  assert.equal(judgePoster({ ...clean, photo: "missing" }, COPY, { photoGiven: true }).pass, false);
});

test("words() treats dashes and punctuation alike", () => {
  assert.deepEqual(words("4:20PM – 10PM"), words("4:20pm - 10pm"));
  assert.deepEqual(words("company."), ["company"]);
});

test("the read-back prompt fills with and without a photo, and the schema takes a model reply", () => {
  const withPhoto = loadPrompt("read-back", { copy: COPY.join("\n"), photo_line: "The owner's photo is the third.", logo_line: "The logo spot is the top-left corner." });
  assert.match(withPhoto.user, /photo is the third/);
  assert.match(withPhoto.system, /logo_text/);
  assert.equal(PosterReadSchema.safeParse(clean).success, true);
  assert.equal(PosterReadSchema.safeParse({ ...clean, photo: "maybe" }).success, false);
});

test("the OpenAI painter moves to the next model on a 404 and never sends the key elsewhere", async () => {
  const seen: { url: string; auth: string; model: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const model = String((init.body as FormData).get("model"));
    seen.push({ url, auth: String((init.headers as Record<string, string>).authorization), model });
    if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await paintOpenAI({ apiKey: "test-key", text: "Paint.", images: [{ mediaType: "image/png", base64: Buffer.from("x").toString("base64") }], aspect: "1:1", fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.model, seen[1]!.model);
  for (const s of seen) {
    assert.equal(s.url, "https://api.openai.com/v1/images/edits");
    assert.equal(s.auth, "Bearer test-key");
  }
});

test("words already in the owner's photo, like the shop's own sign, aren't invented copy", () => {
  const v = judgePoster({ ...clean, photo_text: ["good company RECORDS & CDs"], text: [...clean.text, "good company RECORDS & CDs"] }, COPY, { photoGiven: true });
  assert.equal(v.pass, true, v.problems.join("; "));
});

test("with the logo set by code, a painted logo or a cluttered logo spot fails, and an empty spot passes", () => {
  const empty = { ...clean, logo: "missing" as const, logo_count: 0, logo_text: [] };
  assert.equal(judgePoster(empty, COPY, { photoGiven: true, logoByCode: true }).pass, true);
  // Nov 27 speed run 2: the painter misspelled the logo's small line and painted it twice.
  const painted = judgePoster({ ...clean, logo: "redrawn", logo_count: 2 }, COPY, { photoGiven: true, logoByCode: true });
  assert.equal(painted.pass, false);
  assert.match(painted.problems.join(), /a logo is painted/);
  assert.doesNotMatch(painted.problems.join(), /appears 2 times/);
  const cluttered = judgePoster({ ...empty, logo_spot_clear: false }, COPY, { photoGiven: true, logoByCode: true });
  assert.match(cluttered.problems.join(), /logo spot isn't plain paper/);
});

test("the logo fits inside its spot, keeping its shape", () => {
  const wide = logoRect(1024, 1536, 800, 200);
  assert.deepEqual([wide.x, wide.y], [61, 77]);
  assert.ok(wide.w <= 1024 * LOGO_SPOT.w + 1 && wide.h <= 1536 * LOGO_SPOT.h + 1);
  assert.ok(Math.abs(wide.w / wide.h - 4) < 0.05);
  const tall = logoRect(1080, 1080, 300, 600);
  assert.ok(tall.h <= 1080 * LOGO_SPOT.h + 1 && Math.abs(tall.w / tall.h - 0.5) < 0.05);
});
