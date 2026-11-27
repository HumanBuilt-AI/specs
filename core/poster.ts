// Posters painted whole by an image model (Nov 27 poster spike, option C), checked in code before
// anyone sees them. The image model may paint the art and the type, but every word must match the
// copy, the logo must be the brand's own mark exactly once, and the owner's photo must still be the
// owner's photo. Nothing here calls a model: the read-back schema goes to Claude, and judgePoster
// turns its answer into a pass or a list of problems a repaint can be told about.
import { z } from "zod";

export const PosterReadSchema = z.object({
  text: z.array(z.string()).describe("Every piece of text on the poster outside the logo, exactly as painted, one entry per line or block."),
  logo_text: z.array(z.string()).describe("Text that is part of the logo itself (its name, its small lines)."),
  logo: z.enum(["same", "redrawn", "missing"]).describe("Is the logo the brand's real mark, a redrawn or altered one, or absent?"),
  logo_count: z.number().int().min(0).describe("How many times the logo appears, counting a logo on a sign inside the photo."),
  logo_notes: z.string(),
  photo: z.enum(["same", "changed", "missing", "none_given"]).describe("Is the owner's photo on the poster as given (cropped or tinted is fine), or are its people, signs or place repainted or invented?"),
  photo_notes: z.string(),
  hard_to_read: z.array(z.string()).describe("Copy from the brief that is there but hard to read on a phone. Empty if none."),
});
export type PosterRead = z.infer<typeof PosterReadSchema>;

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
 * `photoGiven` is false when the poster has no owner photo to keep.
 */
export function judgePoster(read: PosterRead, copy: string[], opts: { photoGiven: boolean }): PosterVerdict {
  const want = new Set(copy.flatMap(words));
  const logoWords = new Set(read.logo_text.flatMap(words));
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
    ...(read.logo === "redrawn" ? [`the logo is redrawn instead of the brand's own mark (${read.logo_notes})`] : []),
    ...(read.logo === "missing" ? ["the logo is missing"] : []),
    ...(read.logo !== "missing" && read.logo_count > 1 ? [`the logo appears ${read.logo_count} times; it should appear once`] : []),
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
  return [
    "The last painting failed these checks. Fix them and keep everything else about the design:",
    ...v.problems.map((p) => `- ${p}`),
  ].join("\n");
}
