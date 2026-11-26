// A visitor's kit: drafted chunks become the files the post pipeline reads, with tokens built in code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kitFromChunks, contrast, businessNameOf, ownerFonts, googleFontsHref } from "../core/session-kit.ts";
import { resolveFont, fontsNamedIn, fontFamilyFromFile, sniffFont, headingWeightOf } from "../core/fonts.ts";
import { selectChunks, parseChunks } from "../core/kit.ts";
import type { IntakeChunks } from "../core/intake.ts";

const src = [{ upload: "flyer.pdf", location: "page 1" }];
import type { IntakeItem } from "../core/intake.ts";
const item = (label: string, value: string): IntakeItem => ({ label, value, why: null, sources: src, confidence: "high" });
const draft = (items: IntakeItem[]) => ({ summary: "s", confidence: "high" as const, items, missing: [] });

const chunks: IntakeChunks = {
  "positioning-core": { draft: draft([item("what_it_is", "A pizza window"), item("fact: business_name", "Night Slice")]) },
  "voice-core": { draft: draft([item("tone", "Loud")]) },
  "visual-system": {
    draft: draft([
      item("color: background", "#111111 night black"),
      item("color: body_text", "#222222 (too dark on black)"),
      item("color: accent", "#F5C518 sign yellow"),
      item("type: heading", "Tall condensed poster capitals, like Anton"),
      item("type: body", "Inter"),
    ]),
  },
};

test("colors come from the roles, and unreadable body text is fixed", () => {
  const kit = kitFromChunks(chunks, { name: "Night Slice" });
  assert.equal(kit.colors.background, "#111111");
  assert.equal(kit.colors.accent, "#F5C518");
  assert.ok(contrast(kit.colors.text, kit.colors.background) >= 4.5);
  assert.match(kit.notes.join(" "), /too faint/);
  assert.match(kit.tokensCss, /--role-background: var\(--color-background\)/);
});

test("a second strong brand color the roles left out is kept as accent 2", () => {
  const neon: IntakeChunks = {
    ...chunks,
    "visual-system": { draft: draft([...chunks["visual-system"]!.draft.items, item("color: heading", "#F5C518 sign yellow"), item("color: neon", "#FF2E88 neon pink, the SLICE sign")]) },
  };
  const kit = kitFromChunks(neon, { name: "Night Slice" });
  assert.equal(kit.colors.accent2, "#FF2E88");
  assert.match(kit.tokensCss, /--color-accent-2: #FF2E88;/);
  assert.match(kit.tokensCss, /--role-accent-2: var\(--color-accent-2\);/);
  // No second hue, no accent 2.
  assert.equal(kitFromChunks(chunks, { name: "Night Slice" }).colors.accent2, null);
});

test("fonts: any named Google font passes through, a description gets a stand-in by style", () => {
  assert.deepEqual(resolveFont("Inter, 400", "Lora"), { font: "Inter", standIn: false, category: "sans-serif" });
  assert.equal(resolveFont("Plus Jakarta Sans, light", "Inter").font, "Plus Jakarta Sans");
  assert.equal(resolveFont("Tall condensed poster capitals", "Inter").font, "Archivo Black");
  assert.equal(resolveFont("a classic garamond", "Inter").font, "Lora");
  const kit = kitFromChunks(chunks, { name: "Night Slice" });
  assert.equal(kit.fonts.heading, "Anton");
  assert.equal(kit.fonts.body, "Inter");
});

test("a word that contains 'script' doesn't make a serif handwritten (Good Company, Nov 26)", () => {
  const desc = "Heavy, soft lowercase serif, same as the wordmark. The descriptor line is small, widely letterspaced uppercase sans-serif with a middle dot: 'RECORDS & CDS · MINNEAPOLIS'";
  assert.equal(resolveFont(desc, "Fraunces").font, "Fraunces");
  assert.equal(resolveFont("Light, regular-weight sans-serif in sentence case", "Inter").font, "Inter");
  assert.equal(resolveFont("Loose brush script, like a sign painter", "Inter").font, "Caveat");
  const gc: IntakeChunks = { ...chunks, "visual-system": { draft: draft([item("type: heading", desc), item("type: body", "Light, regular-weight sans-serif")]) } };
  const kit = kitFromChunks(gc, { name: "Good Company" });
  assert.equal(kit.fonts.heading, "Fraunces");
  assert.equal(kit.fonts.hand, "Inter");
});

test("fonts named in text: as Google spells them, or squashed together as typed", () => {
  assert.deepEqual(
    fontsNamedIn("I specifically want to use Fraunces for headline and PlusJakartaSans for body both google fonts").map((f) => f.family),
    ["Fraunces", "Plus Jakarta Sans"],
  );
  assert.deepEqual(fontsNamedIn("a heavy, soft lowercase serif; play up the plum").map((f) => f.family), []);
  assert.deepEqual(fontsNamedIn("Set in DM Serif Display").map((f) => f.family), ["DM Serif Display"]);
});

test("an owner's font answer: a card pick, or typed words naming fonts", () => {
  assert.deepEqual(ownerFonts("Fonts: Fraunces for headings, Manrope for body text"), { heading: "Fraunces", body: "Manrope" });
  assert.deepEqual(ownerFonts("Owner wrote: PlusJakartaSans"), { body: "Plus Jakarta Sans" });
  assert.deepEqual(ownerFonts("Fraunces for headline and PlusJakartaSans for body"), { heading: "Fraunces", body: "Plus Jakarta Sans" });
  assert.deepEqual(ownerFonts("Use Inter for body text and Fraunces for headlines"), { heading: "Fraunces", body: "Inter" });
  assert.deepEqual(ownerFonts("Fonts: none of these"), {});
});

test("the owner's typed font answer reaches the posts, keeping the other role", () => {
  const items = [item("type: heading", "Heavy, soft serif. The descriptor is a sans."), item("fonts", "Fonts: Fraunces for headings, Inter for body text"), item("fonts", "Owner wrote: PlusJakartaSans")];
  const kit = kitFromChunks({ ...chunks, "visual-system": { draft: draft(items) } }, { name: "Good Company" });
  assert.equal(kit.fonts.heading, "Fraunces");
  assert.equal(kit.fonts.body, "Plus Jakarta Sans");
  assert.match(googleFontsHref(Object.values(kit.fonts)), /family=Plus\+Jakarta\+Sans:wght@400;700/);
});

test("uploaded font files: a serif leads, a sans sets the body; a font Google lacks comes from the file", () => {
  const vis = { draft: draft([item("type: heading", "A tall condensed sans"), item("type: body", "Light sans")]) };
  const kit = kitFromChunks({ ...chunks, "visual-system": vis }, { name: "Good Company", fonts: [{ family: "Plus Jakarta Sans", google: true }, { family: "Fraunces", google: true }] });
  assert.equal(kit.fonts.heading, "Fraunces");
  assert.equal(kit.fonts.body, "Plus Jakarta Sans");
  const own = kitFromChunks({ ...chunks, "visual-system": vis }, { name: "Good Company", fonts: [{ family: "Brand Serif", google: false }] });
  assert.equal(own.fonts.heading, "Brand Serif");
  assert.match(own.notes.join(" "), /font file you uploaded/);
  // The owner's answer still outranks the files.
  const answered = kitFromChunks({ ...chunks, "visual-system": { draft: draft([...vis.draft.items, item("fonts", "Fonts: Lora for headings, Inter for body text")]) } }, { name: "x", fonts: [{ family: "Fraunces", google: true }] });
  assert.equal(answered.fonts.heading, "Lora");
});

test("font files: family from the file name, format from the first bytes", () => {
  assert.equal(fontFamilyFromFile("PlusJakartaSans.ttf"), "Plus Jakarta Sans");
  assert.equal(fontFamilyFromFile("Fraunces[SOFT,WONK,opsz,wght].ttf"), "Fraunces");
  assert.equal(fontFamilyFromFile("PlusJakartaSans-BoldItalic.woff2"), "Plus Jakarta Sans");
  assert.equal(fontFamilyFromFile("BrandSerif-Regular.otf"), "Brand Serif");
  assert.equal(sniffFont(new Uint8Array([0, 1, 0, 0])), "ttf");
  assert.equal(sniffFont(new TextEncoder().encode("wOF2xxxx")), "woff2");
  assert.equal(sniffFont(new TextEncoder().encode("%PDF")), null);
  assert.equal(headingWeightOf("Anton"), 400);
  assert.equal(headingWeightOf("Fraunces"), 700);
});

test("body text never gets a handwriting face", () => {
  const hand: IntakeChunks = { ...chunks, "visual-system": { draft: draft([...chunks["visual-system"]!.draft.items, item("type: body", "Hand-painted marker lettering, like the menu board")]) } };
  const kit = kitFromChunks(hand, { name: "Night Slice" });
  assert.equal(kit.fonts.body, "Inter");
  assert.match(kit.notes.join(" "), /handwriting face/);
});

test("an owner's palette answer outranks the draft's roles", () => {
  const withPalette: IntakeChunks = {
    ...chunks,
    "visual-system": { draft: draft([...chunks["visual-system"]!.draft.items, item("palette", "Palette: Day (#F4F1EA, #111111, #FF2E88)")]) },
  };
  const kit = kitFromChunks(withPalette, { name: "Night Slice" });
  assert.equal(kit.colors.background, "#F4F1EA");
  assert.equal(kit.colors.text, "#111111");
  assert.equal(kit.colors.accent, "#FF2E88");
});

test("the files load through the same selection the demo kits use", () => {
  const kit = kitFromChunks(chunks, { name: "Night Slice" });
  const picked = selectChunks(kit.files, "post_generate", "tip");
  assert.deepEqual(picked.chunks.map((c) => c.id).sort(), ["art-direction", "social-rules", "terminology", "visual-system", "voice-core"]);
  assert.ok(parseChunks(kit.files).has("positioning-core"));
});

test("the business name comes from the facts list", () => {
  assert.equal(businessNameOf(chunks), "Night Slice");
  assert.equal(businessNameOf({}), null);
});

test("a note the model added after the business name stays out of the wordmark", () => {
  const withNote = (value: string): IntakeChunks => ({
    ...chunks,
    "positioning-core": { draft: draft([item("fact: business_name", value)]) },
  });
  assert.equal(businessNameOf(withNote("SŌMA (printed on the box front and engraved on the ring, with a macron)")), "SŌMA");
  assert.equal(businessNameOf(withNote("Night Slice — from the menu board")), "Night Slice");
  assert.equal(businessNameOf(withNote("\"Third Shift Slice\"")), "Third Shift Slice");
  assert.equal(businessNameOf(withNote("Half-Acre Club")), "Half-Acre Club");
});

test("a palette can name the headline color, and posts are held to it", () => {
  const withHeading: IntakeChunks = {
    ...chunks,
    "visual-system": { draft: draft([...chunks["visual-system"]!.draft.items, item("palette", "Palette: Pink titles (#14110F, #FFFFFF, #FFDB04); headings #FF189B")]) },
  };
  const kit = kitFromChunks(withHeading, { name: "Night Slice" });
  assert.equal(kit.colors.heading, "#FF189B");
  assert.equal(kit.colors.text, "#FFFFFF");
  assert.notEqual(kit.colors.accent2, "#FF189B", "the headline pick isn't read as a palette color");
  assert.match(kit.tokensCss, /\[data-slot="headline"\] \{ color: var\(--color-heading\) !important; \}/);
  assert.doesNotMatch(kitFromChunks(chunks, { name: "Night Slice" }).tokensCss, /!important/);
});

test("a logo size answer sets the logo height for every post", () => {
  const sized: IntakeChunks = {
    ...chunks,
    "visual-system": { draft: draft([...chunks["visual-system"]!.draft.items, item("owner: logo size", "Logo size: 130% of the standard size")]) },
  };
  assert.match(kitFromChunks(sized, { name: "Night Slice" }).tokensCss, /--logo-height: 4\.16em;/);
  assert.doesNotMatch(kitFromChunks(chunks, { name: "Night Slice" }).tokensCss, /--logo-height/);
});
