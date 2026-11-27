// What the owner sets up front, one step at a time (Scott, Nov 26): hero photos, a palette by
// role, and a font pair, chosen before any words are read. Code turns them into kit items with
// the owner as their source, so the drafted kit starts from them and intake doesn't ask again.
// Pure: no file access.
import { z } from "zod";
import type { Swatch } from "./colors.ts";
import type { ExtractChunkId } from "./extract.ts";
import type { IntakeItem } from "./intake.ts";

export const PALETTE_ROLES = ["background", "text", "headings", "accent", "extra"] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
/** In order of use: most of the post first, small touches last. */
export const ROLE_TEXT: Record<PaletteRole, { name: string; hint: string }> = {
  background: { name: "Background", hint: "Most of the post" },
  text: { name: "Text", hint: "Body copy" },
  headings: { name: "Headlines", hint: "The big words" },
  accent: { name: "Accent", hint: "Buttons, stamps, rules" },
  extra: { name: "Extra", hint: "A second pop, used sparingly" },
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const font = z.string().trim().min(1).max(60);
export const PicksSchema = z.strictObject({
  palette: z.array(z.strictObject({ role: z.enum(PALETTE_ROLES), hex })).min(2).max(6).optional(),
  fonts: z.strictObject({ heading: font, body: font }).optional(),
  /** Upload ids of the photos the owner starred. */
  heroes: z.array(z.string().uuid()).max(2).optional(),
});
export type Picks = z.infer<typeof PicksSchema>;

/** Where an item the owner set up front says it came from. */
export const PICKS_SOURCE = { upload: "owner", location: "set before reading" } as const;
export const isPicked = (item: Pick<IntakeItem, "sources">) => item.sources.some((s) => s.upload === PICKS_SOURCE.upload && s.location === PICKS_SOURCE.location);

/** "Palette: background #361E39, text #F4EBDD, headings #F4EBDD, accent #BE3042". pickColors reads the roles back. */
export function paletteText(palette: NonNullable<Picks["palette"]>): string {
  return `Palette: ${palette.map((p) => `${p.role} ${p.hex.toUpperCase()}`).join(", ")}`;
}

/** The kit items the picks make, by chunk. Heroes are named by their upload labels. */
export function picksItems(picks: Picks, labelOf: (uploadId: string) => string | undefined): Partial<Record<ExtractChunkId, IntakeItem[]>> {
  const item = (label: string, value: string, why: string): IntakeItem => ({ label, value, why, sources: [{ ...PICKS_SOURCE }], confidence: "high", edited: true });
  const out: Partial<Record<ExtractChunkId, IntakeItem[]>> = {};
  const visual: IntakeItem[] = [];
  if (picks.palette?.length) visual.push(item("palette", paletteText(picks.palette), "The owner set these colors by role before anything was read."));
  if (picks.fonts) visual.push(item("fonts", `Fonts: ${picks.fonts.heading} for headings, ${picks.fonts.body} for body text`, "The owner chose these fonts."));
  if (visual.length) out["visual-system"] = visual;
  const heroes = (picks.heroes ?? []).map(labelOf).filter((l): l is string => !!l);
  if (heroes.length) out["art-direction"] = [item("hero_photos", `Hero photos: ${heroes.join("; ")}`, "The owner starred these photos to lead their posts.")];
  return out;
}

/** The picks as plain statements for the assemble step, so drafted chunks agree with them. */
export function picksStatements(picks: Picks, labelOf: (uploadId: string) => string | undefined): string[] {
  const out: string[] = [];
  if (picks.palette?.length) out.push(`The owner set the brand palette by role: ${picks.palette.map((p) => `${p.role} ${p.hex.toUpperCase()}`).join(", ")}. These are the brand colors.`);
  if (picks.fonts) out.push(`The owner chose the fonts: ${picks.fonts.heading} for headlines, ${picks.fonts.body} for body text.`);
  const heroes = (picks.heroes ?? []).map(labelOf).filter(Boolean);
  if (heroes.length) out.push(`The owner starred these photos to lead posts: ${heroes.join("; ")}.`);
  return out;
}

// ---------- the palette step ----------

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
function lab(h: string): [number, number, number] {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(h).map(lin) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** How different two colors look (CIE76): under about 10 most people call them the same color. */
export function deltaE(a: string, b: string): number {
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
const chroma = (h: string) => {
  const [, a, b] = lab(h);
  return Math.hypot(a, b);
};
const lightness = (h: string) => lab(h)[0];

export type Candidate = { hex: string; from: "typed" | "logo" | "photo"; share: number };
export type ColorSource = { kind: "logo" | "image"; colors: Swatch[] };

/** Colors this close count as one. Muted colors merge sooner, so a shop photo doesn't give five browns. */
const SAME = 14;
const SAME_MUTED = 22;

/**
 * The colors to build a palette from: hex values the owner typed, then the logo's, then the
 * photos' by how much of the photos they cover. Near-duplicates are merged into the first one
 * seen, and specks under 2% of a photo are left out.
 */
export function paletteCandidates(sources: ColorSource[], typed: string[] = [], max = 12): Candidate[] {
  const pool: Candidate[] = [
    ...typed.map((h) => ({ hex: h.toUpperCase(), from: "typed" as const, share: 1 })),
    ...sources.filter((s) => s.kind === "logo").flatMap((s) => s.colors.filter((c) => c.share >= 0.01).map((c) => ({ hex: c.hex.toUpperCase(), from: "logo" as const, share: c.share }))),
  ];
  const photoTotals = new Map<string, number>();
  const photos = sources.filter((s) => s.kind === "image");
  for (const s of photos) for (const c of s.colors) if (c.share >= 0.02) photoTotals.set(c.hex.toUpperCase(), (photoTotals.get(c.hex.toUpperCase()) ?? 0) + c.share / Math.max(1, photos.length));
  pool.push(...[...photoTotals].sort((a, b) => b[1] - a[1]).map(([hex, share]) => ({ hex, from: "photo" as const, share })));

  const out: Candidate[] = [];
  for (const c of pool) {
    const near = out.find((o) => deltaE(o.hex, c.hex) < (chroma(o.hex) < 20 && chroma(c.hex) < 20 ? SAME_MUTED : SAME));
    if (near) {
      if (near.from === c.from) near.share += c.share;
      continue;
    }
    out.push({ ...c });
  }
  return out.slice(0, max);
}

const lum = (h: string) => {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(h).map(ch) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastOf = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * A first palette to adjust: the background is the brand's own strongest light or dark (typed or
 * logo colors first), text is whatever reads best on it, the accent is the most colorful brand
 * color left, and an extra is a colorful one clearly different from the accent.
 */
export function suggestPalette(cands: Candidate[]): { role: PaletteRole; hex: string }[] {
  if (!cands.length) return [];
  const brand = cands.filter((c) => c.from !== "photo");
  const pool = brand.length >= 2 ? brand : cands;
  const ends = (list: Candidate[]) => list.filter((c) => lightness(c.hex) > 85 || lightness(c.hex) < 25);
  const background = (ends(pool)[0] ?? ends(cands)[0] ?? pool[0]!).hex;
  const rest = cands.filter((c) => c.hex !== background);
  const text = [...rest].sort((a, b) => contrastOf(b.hex, background) - contrastOf(a.hex, background))[0]?.hex ?? (contrastOf("#141414", background) >= contrastOf("#FFFFFF", background) ? "#141414" : "#FFFFFF");
  const colorful = (list: Candidate[]) => list.filter((c) => c.hex !== background && c.hex !== text && chroma(c.hex) >= 25).sort((a, b) => chroma(b.hex) - chroma(a.hex));
  const accent = colorful(pool)[0]?.hex ?? colorful(cands)[0]?.hex;
  const out: { role: PaletteRole; hex: string }[] = [
    { role: "background", hex: background },
    { role: "text", hex: text },
    { role: "headings", hex: text },
  ];
  if (accent) {
    out.push({ role: "accent", hex: accent });
    const extra = colorful(cands).find((c) => c.hex !== accent && deltaE(c.hex, accent) > 30 && contrastOf(c.hex, background) >= 3);
    if (extra) out.push({ role: "extra", hex: extra.hex });
  }
  return out;
}

/** Hex values in pasted text ("#361e39, #BE3042"), in order, once each. */
export const typedHexes = (s: string) => [...new Set((s.match(/#[0-9a-f]{6}\b/gi) ?? []).map((h) => h.toUpperCase()))];

// ---------- the words step ----------

export const DOC_PURPOSES = ["facts", "voice", "skip"] as const;
export type DocPurpose = (typeof DOC_PURPOSES)[number];
/** A first guess at what a text file is for: prompts written for an image tool aren't about the business. */
export function guessPurpose(name: string): DocPurpose {
  if (/prompt|generation|midjourney|dall-?e|imagen|gemini|negative|\bai\b|_ai_|-ai-/i.test(name)) return "skip";
  if (/voice|tone|copy|captions?|posts?|tagline|social/i.test(name)) return "voice";
  return "facts";
}

// ---------- the logo on the post's background ----------

/** Below this contrast a logo's ink reads as part of the background (plum #361E39 on plum is 1.0). */
const VANISHES = 1.8;
const hex2 = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * A logo that would vanish on the post's background becomes a knockout: the parts too close to
 * the background are redrawn in the kit's text color (or near-black or white, whichever reads),
 * keeping its shape and its other colors. A logo with its own solid background shows as a badge
 * and is left alone, and so is one that already reads. A design rule, so code, not the model
 * (Scott, Nov 27). Changes RGBA pixels in place; true when it changed any.
 */
export function knockoutPixels(px: Uint8ClampedArray | number[], background: string, text: string | null): boolean {
  let clear = 0, ink = 0, faint = 0;
  const cache = new Map<number, boolean>();
  const fades = (i: number) => {
    const key = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = contrastOf(hex2(px[i]!, px[i + 1]!, px[i + 2]!), background) < VANISHES));
    return v;
  };
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 40) {
      clear++;
      continue;
    }
    ink++;
    if (fades(i)) faint++;
  }
  const total = px.length / 4;
  if (!total || clear / total < 0.08 || !ink || faint / ink < 0.25) return false;
  const knock = text && contrastOf(text, background) >= 3 ? text : contrastOf("#141414", background) >= contrastOf("#FFFFFF", background) ? "#141414" : "#FFFFFF";
  const [r, g, b] = rgb(knock);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 40 || !fades(i)) continue;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  return true;
}
