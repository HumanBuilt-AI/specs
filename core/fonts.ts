// Fonts for a kit: which Google Fonts family a name or description means, and how to load it.
// Owners can name any Google Font (Scott, Nov 26), so posts render it exactly. A description with
// no name ("a heavy, soft serif") gets the closest of the curated faces; a file the owner uploaded
// is used as is. Pure: no file or network access.
import { CURATED_FONTS } from "./catalog.ts";
import { GOOGLE_FONT_ROWS } from "./google-fonts.ts";

export type FontCategory = "sans-serif" | "serif" | "display" | "handwriting" | "monospace";
export type GoogleFont = { family: string; category: FontCategory; weights: number[] };

const CATEGORY: Record<string, FontCategory> = { s: "sans-serif", r: "serif", d: "display", h: "handwriting", m: "monospace" };
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let table: Map<string, GoogleFont> | null = null;
function fonts(): Map<string, GoogleFont> {
  if (table) return table;
  table = new Map();
  for (const row of GOOGLE_FONT_ROWS.split("\n")) {
    const [family, cat, weights] = row.split("|") as [string, string, string];
    table.set(squash(family), { family, category: CATEGORY[cat]!, weights: weights.split(",").map(Number) });
  }
  return table;
}

/** The Google font with this exact name, ignoring case and spaces ("PlusJakartaSans" is Plus Jakarta Sans). */
export function googleFont(name: string): GoogleFont | null {
  return fonts().get(squash(name)) ?? null;
}

// Family names that are also everyday words; a description saying "Play up the plum" names no font.
const WORDS = new Set(["Average", "Basic", "Play", "Prompt", "Ultra", "Poly", "Bitter", "Outfit", "Oi", "Ole", "Cookie"].map(squash));

/**
 * Google fonts a piece of text names, in the order it names them. Matches the family as Google
 * spells it (capitalized, whole words) or squashed together as people type it ("PlusJakartaSans").
 * Longer names win, so "Fraunces" inside "Fraunces Soft" isn't read twice.
 */
export function fontsNamedIn(text: string): GoogleFont[] {
  const found: { at: number; end: number; font: GoogleFont }[] = [];
  const taken = (at: number, end: number) => found.some((f) => at < f.end && end > f.at);
  const lower = text.toLowerCase();
  const flat = squash(text);
  const all = [...fonts().values()].sort((a, b) => b.family.length - a.family.length);
  for (const font of all) {
    // Cheap test first: most of the ~1,900 names aren't in the text at all.
    if (!flat.includes(squash(font.family))) continue;
    if (WORDS.has(squash(font.family)) && !text.includes(`"${font.family}"`)) continue;
    const spaced = new RegExp(`(?<![\\p{L}\\d])${font.family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "gu");
    for (const m of text.matchAll(spaced)) {
      if (!taken(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, font });
    }
    // Typed without spaces: only for names of two words or more, which can't be a common word.
    if (font.family.includes(" ") && !lower.includes(font.family.toLowerCase())) {
      const joined = font.family.replace(/\s+/g, "");
      for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\d])${joined}(?![\\p{L}\\d])`, "giu"))) {
        if (!taken(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, font });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.font).filter((f, i, xs) => xs.findIndex((x) => x.family === f.family) === i);
}

type Curated = (typeof CURATED_FONTS)[number];

// A description with no font name gets the closest curated face. Whole words only: "descriptor"
// once matched "script" and set a heavy serif logo's posts in handwriting (Nov 26). Checked in
// order, so "soft serif" wins over "heavy".
const STYLE_STAND_INS: [RegExp, Curated][] = [
  [/\b(script|cursive|handwritten|handwriting|hand-?lettered|hand-?drawn lettering|brush|marker)\b/i, "Caveat"],
  [/\bsoft\b[^.]*\bserif\b|\bserif\b[^.]*\bsoft\b|\brounded serif\b/i, "Fraunces"],
  [/\b(didone|high[- ]contrast|fashion|editorial)\b/i, "Playfair Display"],
  [/\b(old[- ]?style|garamond|bookish|classic serif|humanist serif|book serif)\b/i, "Lora"],
  [/\bslab\b/i, "Fraunces"],
  [/\bserif\b/i, "Fraunces"],
  [/\b(condensed|poster|impact|block letters?|display sans|heavy sans|black sans)\b/i, "Archivo Black"],
  [/\b(geometric|grotesk|grotesque)\b/i, "Space Grotesk"],
  [/\b(mono|monospaced?|typewriter)\b/i, "IBM Plex Sans"],
];

/** The first sentence of a description: the rest usually describes a second face ("the descriptor line is a sans"). */
const firstSentence = (s: string) => s.split(/(?<=[.;])\s+/)[0] ?? s;

export type ResolvedFont = { font: string; standIn: boolean; category: FontCategory };

/** The font a name or description means: a named Google font, else the closest curated face by style. */
export function resolveFont(raw: string | undefined, fallback: Curated): ResolvedFont {
  const curatedOf = (f: Curated): ResolvedFont => ({ font: f, standIn: true, category: googleFont(f)?.category ?? "sans-serif" });
  if (!raw?.trim()) return { ...curatedOf(fallback), standIn: false };
  const named = fontsNamedIn(raw)[0];
  if (named) return { font: named.family, standIn: false, category: named.category };
  const lead = firstSentence(raw).replace(/\bsans[- ]?serif\b/gi, "sans");
  const styled = STYLE_STAND_INS.find(([re]) => re.test(lead))?.[1];
  return curatedOf(styled ?? fallback);
}

export const isHandwriting = (font: string) => googleFont(font)?.category === "handwriting";

/** Headings set in a display or handwriting face, or one without a bold, stay at 400. */
export function headingWeightOf(font: string): number {
  const g = googleFont(font);
  if (!g) return 700;
  if (g.category === "display" || g.category === "handwriting") return 400;
  return g.weights.includes(700) ? 700 : Math.max(...g.weights.filter((w) => w <= 700), 400);
}

/** The Google Fonts stylesheet for a kit's fonts. Names that aren't Google fonts (an uploaded file) are left to the page's own @font-face. */
export function googleFontsHref(names: string[]): string {
  const families = [...new Set(names)].map(googleFont).filter((f): f is GoogleFont => !!f).sort((a, b) => a.family.localeCompare(b.family));
  const spec = (f: GoogleFont) => {
    const w = [400, 700].filter((x) => f.weights.includes(x));
    const name = encodeURIComponent(f.family).replace(/%20/g, "+");
    return w.length > 1 ? `family=${name}:wght@${w.join(";")}` : `family=${name}`;
  };
  return `https://fonts.googleapis.com/css2?${families.map(spec).join("&")}&display=swap`;
}

// ---------- uploaded font files ----------

export const FONT_FORMATS = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" } as const;
export type FontExt = keyof typeof FONT_FORMATS;

/** A font file's format from its first bytes, or null if it isn't one. */
export function sniffFont(b: Uint8Array): FontExt | null {
  const tag = String.fromCharCode(...b.slice(0, 4));
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return "ttf";
  return null;
}

const STYLE_WORDS = /[-_ ]?(variable ?font|variable|vf|regular|roman|book|normal|italic|oblique|thin|hairline|extra ?light|ultra ?light|light|medium|semi ?bold|demi ?bold|extra ?bold|ultra ?bold|bold|black|heavy|wght|opsz|ital)\b/gi;

/**
 * The family a font file holds, from its name: "PlusJakartaSans-Bold.ttf" is Plus Jakarta Sans,
 * "Fraunces[SOFT,WONK,opsz,wght].ttf" is Fraunces. A Google font is named as Google spells it;
 * anything else is split at its capitals ("BrandSerif" is "Brand Serif").
 */
export function fontFamilyFromFile(name: string): string {
  const base = name.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/\[[^\]]*\]/g, "");
  // Style words can run together ("BoldItalic"), so strip until nothing changes.
  let plain = base;
  for (let prev = ""; prev !== plain; ) [prev, plain] = [plain, plain.replace(STYLE_WORDS, " ")];
  plain = plain.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || base;
  const g = googleFont(plain) ?? googleFont(base);
  if (g) return g.family;
  return plain.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^\p{L}\d ]+/gu, "").trim().slice(0, 60) || "Uploaded font";
}

/** The @font-face rule for an uploaded font, given its file as a data URL. */
export function fontFaceCss(family: string, dataUrl: string, ext: FontExt): string {
  return `@font-face { font-family: "${family.replace(/["\\]/g, "")}"; src: url("${dataUrl}") format("${FONT_FORMATS[ext]}"); font-weight: 100 900; font-display: block; }\n`;
}
