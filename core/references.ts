// References (build plan "Specs: new kit flow", Nov 27): a Cosmos.so board link or 3–5 images the
// owner likes, plus three sliders (density, contrast, texture). The images go to the painter as
// reference posters; the sliders and a note on what to borrow become the kit's `references` chunk.
// Cosmos has no official API, so the server reads a public board's page and takes the image links
// it finds there, and asks for images when it can't. Pure: no file or network access here.
import { z } from "zod";

export const REFERENCE_SLIDERS = ["density", "contrast", "texture"] as const;
export type ReferenceSlider = (typeof REFERENCE_SLIDERS)[number];
export const MAX_REFERENCES = 5;

const level = z.number().int().min(1).max(5);
export const SlidersSchema = z.strictObject({ density: level, contrast: level, texture: level });
export type Sliders = z.infer<typeof SlidersSchema>;
export const DEFAULT_SLIDERS: Sliders = { density: 3, contrast: 3, texture: 3 };

export type ReferenceImage = { id: string; mediaType: "image/jpeg" | "image/png" | "image/webp"; from: "upload" | "cosmos" };
export type References = { images: ReferenceImage[]; sliders: Sliders; board?: string };

export const SLIDER_LABELS: Record<ReferenceSlider, { name: string; low: string; high: string }> = {
  density: { name: "Density", low: "Airy", high: "Packed" },
  contrast: { name: "Contrast", low: "Soft", high: "Punchy" },
  texture: { name: "Texture", low: "Clean", high: "Worn" },
};

/** What each slider position asks of the painter, in plain words. */
const SLIDER_WORDS: Record<ReferenceSlider, [string, string, string, string, string]> = {
  density: [
    "very airy: one idea and a lot of empty paper",
    "airy: one main idea, generous space around it",
    "balanced: a clear hero with a little supporting art",
    "full: layered art filling most of the canvas",
    "packed: collaged and layered, every part of the canvas working",
  ],
  contrast: [
    "soft: close, quiet tones",
    "gentle: mostly mid tones, one clear accent",
    "clear: strong light and dark, the accent where the eye should land",
    "bold: deep darks against bright lights",
    "punchy: the darkest ground against the brightest accent, nothing in between",
  ],
  texture: [
    "clean: flat, crisp print, no grain",
    "light: a faint paper grain",
    "printed: visible grain and a little ink spread, like a good screen print",
    "worn: heavy grain, uneven ink, a few scuffs",
    "very worn: torn paper, misregistered ink, photocopy noise",
  ],
};

export function sliderWords(s: Sliders): string[] {
  return REFERENCE_SLIDERS.map((k) => `${SLIDER_LABELS[k].name} ${s[k]} of 5: ${SLIDER_WORDS[k][s[k] - 1]}.`);
}

/** The kit's references chunk for a session, written by code from what the owner set. */
export function referencesChunk(r: References): string {
  const n = r.images.length;
  const source = r.board ? `Cosmos board ${r.board}` : "the owner's reference images";
  const lines = [
    "---",
    "chunk_id: references",
    "domain: visual",
    "depends_on: [visual-system, art-direction]",
    "token_count: 220",
    "confidence: high",
    "sources:",
    `  - upload: ${n ? (r.board ? "Cosmos board" : "reference images") : "sliders"}`,
    "    location: References step",
    "version: 1",
    "summary: >-",
    `  ${n ? `${n} reference image${n === 1 ? "" : "s"} the owner likes, and` : "No reference images; only"} how dense, how contrasty and how worn the art should be.`,
    "---",
    "",
    "# References",
    "",
    n
      ? `The owner picked ${n} reference image${n === 1 ? "" : "s"}${r.board ? " from their Cosmos board" : ""}. They are attached to every painting after the owner's photo. Borrow their texture, print quality, type treatment and illustration style, in this brand's colors. Never copy their words, logos, people or products.`
      : "No reference images were given. Take the print feel from the art direction and energy chunks.",
    "",
    "How the art should feel, as the owner set it:",
    "",
    ...sliderWords(r.sliders).map((l) => `- ${l}`),
    "",
    "Why: these sliders are the owner's own call on how loud the brand's pieces are, so they win over a general sense of what the brand could take.",
    "",
  ];
  return lines.join("\n");
}

/** A public Cosmos board or element page: https, on cosmos.so. */
export function cosmosUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "cosmos.so" && host !== "www.cosmos.so") return null;
  return u;
}

/** An image link the server may download: https, on a cosmos.so host. */
export function isCosmosImageHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.port && (host === "cosmos.so" || host.endsWith(".cosmos.so"));
  } catch {
    return false;
  }
}

/**
 * The image links on a board's page, best first: the page's own og:image tags, then image links
 * on cosmos hosts anywhere in the HTML (board pages carry them in img tags and in their data).
 * Thumbnails and avatars are dropped; duplicates (the same file at two sizes) count once.
 */
export function cosmosImageLinks(html: string, max = MAX_REFERENCES): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const url = raw.replace(/\\u002F/gi, "/").replace(/&amp;/g, "&").replace(/\\\//g, "/");
    if (!isCosmosImageHost(url)) return;
    if (/avatar|profile|favicon|logo|icon/i.test(url)) return;
    const key = url.split("?")[0]!;
    if (found.some((f) => f.split("?")[0] === key)) return;
    found.push(url);
  };
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi)) add(m[1]!);
  // Board pages escape their data as JSON ("https:\/\/cdn.cosmos.so\/…"), so unescape before matching.
  const text = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  for (const m of text.matchAll(/https:\/\/([a-z0-9.-]*cosmos\.so)\/[^"'\s<>)\\]+/gi)) {
    const host = m[1]!.toLowerCase();
    // An image file, or anything on an image host (Cosmos serves images without extensions); the server sniffs every download anyway.
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(m[0]) || /^(cdn|images?|img|media|assets)\./.test(host)) add(m[0]);
  }
  return found.slice(0, max);
}
