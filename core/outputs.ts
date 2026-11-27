// The outputs an owner can pick once the kit is ready (build plan "Specs: new kit flow", Nov 27):
// Poster 11×17, Story 9:16 and Instagram 1:1, in Scott's order. Every output is painted the same
// way (prompts/poster-full.md). The image model only paints 1024×1024 and 1024×1536, so the tall
// outputs are painted 2:3 and trimmed at the sides to their own shape; the painter is told which
// strips get trimmed, so it keeps every word and the logo spot inside what stays.
export const OUTPUT_FORMATS = ["poster", "story", "square"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type OutputSpec = {
  label: string;
  /** One line on what it's for, under the thumbnail. */
  use: string;
  /** Width over height of the finished piece. */
  ratio: number;
  /** The image model's size. */
  size: "1024x1024" | "1024x1536";
  /** CSS aspect-ratio for previews. */
  css: string;
};

export const OUTPUTS: Record<OutputFormat, OutputSpec> = {
  poster: { label: "Poster", use: "11×17, for print and the shop window", ratio: 11 / 17, size: "1024x1536", css: "11 / 17" },
  story: { label: "Story", use: "9:16, for Instagram and Facebook stories", ratio: 9 / 16, size: "1024x1536", css: "9 / 16" },
  square: { label: "Instagram post", use: "1:1, for the feed", ratio: 1, size: "1024x1024", css: "1 / 1" },
};

/** The painted image's width and height in pixels. */
export function paintedSize(f: OutputFormat): { w: number; h: number } {
  const [w, h] = OUTPUTS[f].size.split("x").map(Number) as [number, number];
  return { w, h };
}

/** The share of the painted width that stays once the sides are trimmed (1 for the square). */
export function keptWidth(f: OutputFormat): number {
  const { w, h } = paintedSize(f);
  return Math.min(1, (OUTPUTS[f].ratio * h) / w);
}

/** The part of the painting that is kept, in pixels of the painted image: centered, full height. */
export function cropOf(f: OutputFormat, paintedW: number, paintedH: number) {
  const w = Math.round(paintedW * keptWidth(f));
  return { x: Math.round((paintedW - w) / 2), y: 0, w, h: paintedH };
}

/** The canvas line for the painter: its size, and which side strips are trimmed. */
export function canvasWords(f: OutputFormat): string {
  const o = OUTPUTS[f];
  const { w, h } = paintedSize(f);
  const keep = keptWidth(f);
  if (keep >= 0.999) return `${w} × ${h} px, ${o.label} (${o.use.split(",")[0]}). Keep every word well inside the edges.`;
  const trim = Math.round(((1 - keep) / 2) * 100);
  return `${w} × ${h} px, painted for a ${o.label.toLowerCase()} (${o.use.split(",")[0]}). The outer ${trim}% of the width on each side is trimmed off afterwards: paint only background there, and keep every word, the photo and the logo spot inside the middle ${Math.round(keep * 100)}%.`;
}
