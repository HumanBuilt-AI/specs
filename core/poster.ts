// Posters painted whole by an image model (Nov 27 poster spike, option C), checked in code before
// anyone sees them. The image model may paint the art and the type, but every word must match the
// copy, the logo must be the brand's own mark exactly once, and the owner's photo must still be the
// owner's photo. Nothing here calls a model: the read-back schema goes to Claude, and judgePoster
// turns its answer into a pass or a list of problems a repaint can be told about.
import { z } from "zod";

export const PosterReadSchema = z.object({
  text: z.array(z.string()).describe("Every piece of text on the poster outside the logo, exactly as painted, one entry per line or block."),
  photo_text: z.array(z.string()).describe("Text that was already in the owner's photo (its signs) and still is, inside the photo on the poster."),
  logo_text: z.array(z.string()).describe("Text that is part of the logo itself (its name, its small lines)."),
  logo: z.enum(["same", "redrawn", "missing"]).describe("Is the logo the brand's real mark, a redrawn or altered one, or absent?"),
  logo_count: z.number().int().min(0).describe("How many times the logo appears, counting a logo on a sign inside the photo. When the brief names a logo spot, count only free-standing marks (a logo placed on the poster as a graphic), never one printed on a product, package, shirt or object in the scene."),
  logo_notes: z.string(),
  photo: z.enum(["same", "changed", "missing", "none_given"]).describe("Is the owner's photo on the poster as given (cropped or tinted is fine), or are its people, signs or place repainted or invented?"),
  photo_notes: z.string(),
  hard_to_read: z.array(z.string()).describe("Copy from the brief that is there but hard to read on a phone. Empty if none."),
  logo_spot_clear: z.boolean().describe("Is the logo spot described in the brief plain paper, with no words, marks or illustration in it? True when no logo spot was asked for."),
});
export type PosterRead = z.infer<typeof PosterReadSchema>;

/**
 * Where code sets the owner's real logo on a painted poster, as fractions of the canvas (Nov 27
 * speed run 2: painted logos came back misspelled, "HINNEAPOLIS", or twice). The painter keeps a
 * larger clear area around it (`clear`), so the logo sits on calm paper.
 */
export const LOGO_SPOT = { x: 0.06, y: 0.05, w: 0.28, h: 0.12, clear: { w: 0.48, h: 0.25 } } as const;
/** The least room kept between the logo and the edge of the clear area (so the headline below never touches it), as a fraction of the canvas. */
const LOGO_GAP = 0.03;

/** Where the logo lands on a canvas: fitted inside the spot, aspect kept, top-left aligned. Pixels of the finished (trimmed) canvas. */
export function logoRect(canvasW: number, canvasH: number, logoW: number, logoH: number, ownerScale = 1) {
  // The owner's logo size (the size slider, 50–200%) scales the spot, capped so it ends a gap short of
  // the clear area's edges (Nov 27 ODDIO poster: a 125% logo ran past the clear area onto the headline).
  const most = Math.min((LOGO_SPOT.clear.w - LOGO_SPOT.x - LOGO_GAP) / LOGO_SPOT.w, (LOGO_SPOT.clear.h - LOGO_SPOT.y - LOGO_GAP) / LOGO_SPOT.h);
  const s = Math.min(Math.max(ownerScale, 0.5), most);
  const boxW = canvasW * LOGO_SPOT.w * s;
  const boxH = canvasH * LOGO_SPOT.h * s;
  const scale = Math.min(boxW / Math.max(1, logoW), boxH / Math.max(1, logoH));
  return { x: Math.round(canvasW * LOGO_SPOT.x), y: Math.round(canvasH * LOGO_SPOT.y), w: Math.round(logoW * scale), h: Math.round(logoH * scale) };
}

/** The logo spot in words, for the painter and the proofreader, in percent of the painted image. `keep` is the share of the width that stays after trimming (core/outputs.ts). */
export function logoSpotWords(keep = 1): string {
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  const left = (1 - keep) / 2;
  const from = left > 0.005 ? `from ${pct(left)} across (where the trimmed strip ends)` : "from the left edge";
  return `the top-left corner, ${from} to ${pct(left + LOGO_SPOT.clear.w * keep)} across and from the top edge to ${pct(LOGO_SPOT.clear.h)} down`;
}

export type PosterVerdict = {
  pass: boolean;
  invented: string[];
  missing: string[];
  hardToRead: string[];
  logo: PosterRead["logo"];
  logoCount: number;
  photo: PosterRead["photo"];
  /** Plain sentences, one per problem, for the repaint prompt and the owner's notes. */
  problems: string[];
};

/** Lowercase words, with dashes unified and punctuation dropped, so "4:20PM – 10PM" compares with "4:20pm - 10pm". */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9&:/-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "-");
}

// Words too common to show that a flagged line is the brief's copy rather than the logo's.
const FILLER = new Set(["&", "and", "a", "an", "the", "of", "at", "in", "on", "for", "to", "with"]);

/**
 * Judge a read-back against the copy the poster was given. `copy` is every text slot's value.
 * `photoGiven` is false when the poster has no owner photo to keep; `logoGiven` false when there's no logo file to match.
 */
export function judgePoster(read: PosterRead, copy: string[], opts: { photoGiven: boolean; logoGiven?: boolean; logoByCode?: boolean }): PosterVerdict {
  const logoByCode = opts.logoByCode ?? false;
  // With the logo set by code, the painting must have no free-standing logo (those came back misspelled
  // or twice). The brand's mark printed on its own product or box in the scene is fine (Scott, Nov 27:
  // the ODDIO box read naturally), so the reader leaves those out of logo_count.
  const logoGiven = (opts.logoGiven ?? true) && !logoByCode;
  const want = new Set(copy.flatMap(words));
  // The logo's own words and the words already in the owner's photo (its signs) aren't painted copy.
  // Nov 27 live run: the painter erased the shop's real sign to obey "no other words", and failed the photo check.
  const logoWords = new Set([...read.logo_text, ...read.photo_text].flatMap(words));
  const got = read.text.flatMap(words);
  const gotSet = new Set(got);
  const invented = [...new Set(got.filter((w) => !want.has(w) && !logoWords.has(w)))];
  const missing = [...want].filter((w) => !gotSet.has(w));
  // "Hard to read" is only for the brief's copy. A line made only of the logo's own words, or one that
  // shares no real word with the copy, is the logo's small print: the owner's file, not ours to fix.
  // (Run 3's C1 failed on "RECORDS & CDS · MINNEAPOLIS" though the reader said it was the logo.)
  const hardToRead = read.hard_to_read.filter((line) => {
    const ws = words(line);
    if (!ws.length || ws.every((w) => logoWords.has(w))) return false;
    return ws.some((w) => want.has(w) && !FILLER.has(w));
  });

  const problems = [
    ...invented.map((w) => `"${w}" is painted but isn't in the copy`),
    ...missing.map((w) => `"${w}" from the copy is missing or misspelled`),
    ...hardToRead.map((x) => `hard to read on a phone: ${x}`),
    ...(logoGiven && read.logo === "redrawn" ? [`the logo is redrawn instead of the brand's own mark (${read.logo_notes})`] : []),
    ...(logoGiven && read.logo === "missing" ? ["the logo is missing"] : []),
    ...(logoGiven && read.logo !== "missing" && read.logo_count > 1 ? [`the logo appears ${read.logo_count} times; it should appear once`] : []),
    ...(logoByCode && read.logo_count > 0 ? ["a logo is painted on the poster as a graphic; leave it out (the mark on a product is fine), the real one is set in the logo spot afterwards"] : []),
    ...(logoByCode && !read.logo_spot_clear ? ["the logo spot isn't plain paper; keep it empty for the real logo"] : []),
    ...(opts.photoGiven && read.photo === "changed" ? [`the owner's photo is repainted or changed (${read.photo_notes}); keep it as given`] : []),
    ...(opts.photoGiven && read.photo === "missing" ? ["the owner's photo is missing"] : []),
  ];
  return {
    pass: problems.length === 0,
    invented,
    missing,
    hardToRead,
    logo: read.logo,
    logoCount: read.logo_count,
    photo: read.photo,
    problems,
  };
}

/** What a repaint is told: the problems, and that everything else should stay. */
export function repaintNote(v: PosterVerdict): string {
  // Scott's anti-slop rules (Nov 27): fix only what a check proved, with the smallest change, and
  // keep everything else (the last painting is attached for that). This is the only repair cycle.
  return [
    "The last painting failed these checks. The last painting is attached as the final image. Make the smallest change that fixes each one, and keep everything else exactly as it was: the layout, the colors, the type, the art and the photo. Don't restyle or redesign anything that wasn't listed:",
    ...v.problems.map((p) => `- ${p}`),
  ].join("\n");
}

/** What a repair did, compared with the painting it repaired: the problems it fixed, the ones it didn't, and any it caused. */
export function repairReport(before: string[], after: string[]): { fixed: string[]; unresolved: string[]; introduced: string[] } {
  return { fixed: before.filter((p) => !after.includes(p)), unresolved: before.filter((p) => after.includes(p)), introduced: after.filter((p) => !before.includes(p)) };
}
