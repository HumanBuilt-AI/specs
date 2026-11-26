// A visitor's kit, from drafted chunks to the files the post pipeline reads: one Markdown file
// per chunk (renderChunk), plus the pieces code builds: tokens.css, a readme and the retrieval
// rules. Pure: no file access, so the server, the spike and the tests share it.
//
// Colors and fonts come only from the kit. Colors: the visual-system items by role, or the
// owner's palette answer. Fonts: the owner's answer, then any font files they uploaded, then a
// Google font the kit names (posts load it by name, so it renders exactly), otherwise the closest
// curated face by style, noted in the readme (core/fonts.ts). Text colors that
// fail contrast fall back to near-black or white, because a post you can't read helps no one.
import { fontsNamedIn, googleFont, googleFontsHref as hrefFor, headingWeightOf, resolveFont, type ResolvedFont } from "./fonts.ts";
import { EXTRACT_CHUNKS, renderChunk, type ExtractChunkId } from "./extract.ts";
import type { IntakeChunks, IntakeItem } from "./intake.ts";

export type SessionKit = {
  files: Record<string, string>;
  tokensCss: string;
  wordmarkLines: string[];
  /** accent2: a second brand color the others left out (a neon next to a sign yellow), or null. */
  colors: { background: string; text: string; heading: string; accent: string; label: string; accent2: string | null; headingPinned?: boolean };
  fonts: { heading: string; body: string; wordmark: string; hand: string };
  /** Plain notes on what code decided (font stand-ins, contrast fixes), shown in the readme. */
  notes: string[];
};

// ---------- color ----------

const HEX = /#[0-9a-f]{6}\b/gi;
const hexes = (s: string) => (s.match(HEX) ?? []).map((h) => h.toUpperCase());
const channel = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const saturation = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b);
};
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};
const INK = "#141414";
const WHITE = "#FFFFFF";
const bestInk = (bg: string) => (contrast(INK, bg) >= contrast(WHITE, bg) ? INK : WHITE);

// The latest item wins: intake appends or edits, so an owner's answer comes after the draft's guess.
const lastItem = (items: IntakeItem[], ...prefixes: string[]) =>
  [...items].reverse().find((i) => prefixes.some((p) => i.label.toLowerCase().trim().startsWith(p)));

function pickColors(items: IntakeItem[], notes: string[]) {
  const role = (p: string) => hexes(lastItem(items, p)?.value ?? "")[0];
  // A palette answer can also name the headline color: "Palette: … (#…, #…); headings #FF189B".
  const paletteValue = lastItem(items, "palette")?.value ?? "";
  const palette = hexes(paletteValue.replace(/;\s*headings?\b.*$/i, ""));
  const headingPick = hexes(paletteValue.match(/;\s*headings?\s+(#[0-9a-f]{6})/i)?.[1] ?? "")[0];
  const any = [...new Set(items.filter((i) => i.label.toLowerCase().startsWith("color")).flatMap((i) => hexes(i.value)))];
  const pool = palette.length ? palette : any;
  // A palette set by role ("Palette: background #…, text #…, headings #…, accent #…, extra #…").
  const tagged = (r: string) => hexes(paletteValue.match(new RegExp(`\\b${r}\\s+(#[0-9a-f]{6})`, "i"))?.[1] ?? "")[0];
  const byRole = !!tagged("background");

  // An owner's palette answer outranks the draft's role guesses.
  let background = (palette.length ? (byRole ? tagged("background") : palette[0]) : role("color: background")) ?? pool[0] ?? "#F5F3EF";
  let text = (byRole ? tagged("text") : palette.length ? undefined : role("color: body_text")) ?? [...pool].filter((h) => h !== background).sort((a, b) => contrast(b, background) - contrast(a, background))[0] ?? bestInk(background);
  const heading0 = headingPick ?? (byRole ? tagged("headings") : undefined) ?? (palette.length ? undefined : role("color: heading")) ?? text;
  const accent0 =
    (byRole ? tagged("accent") : undefined) ??
    (palette.length ? undefined : role("color: accent")) ??
    [...pool].filter((h) => h !== background && h !== text).sort((a, b) => saturation(b) - saturation(a))[0] ??
    text;

  if (contrast(text, background) < 4.5) {
    const fixed = bestInk(background);
    notes.push(`Body text ${text} on ${background} is too faint to read (${contrast(text, background).toFixed(1)}:1), so posts use ${fixed} for body text.`);
    text = fixed;
  }
  const heading = contrast(heading0, background) >= 3 ? heading0 : text;
  if (heading !== heading0) notes.push(`Heading color ${heading0} is too faint on ${background}, so headings use the body text color.`);
  const accent = accent0;
  const label = contrast(background, accent) >= contrast(text, accent) ? background : text;
  // Keep a second strong color when the brand has one the roles didn't use, so a layout can reach
  // it: a colorful hue clearly different from the heading and accent, readable on the background.
  const used = [background, text, heading, accent];
  const accent2 =
    (byRole ? tagged("extra") : undefined) ??
    [...pool]
      .filter((h) => !used.includes(h) && saturation(h) >= 0.35 && used.filter((u) => saturation(u) >= 0.35).every((u) => hueGap(h, u) >= 40) && contrast(h, background) >= 3)
      .sort((a, b) => saturation(b) - saturation(a))[0] ?? null;
  // The owner named a headline color and it reads on the background: posts must use it.
  const pinned = headingPick ?? (byRole ? tagged("headings") : undefined);
  const headingPinned = !!pinned && heading === pinned;
  return { background, text, heading, accent, label, accent2, headingPinned };
}

// ---------- fonts ----------

/** A font file the owner uploaded: its family, and whether Google serves it too (then posts load it from Google). */
export type UploadedFont = { family: string; google: boolean };

/**
 * The owner's own font answer as heading and body, from a card pick ("Fonts: Fraunces for headings,
 * Inter for body text") or typed words naming Google fonts ("Fraunces for headlines and Plus
 * Jakarta Sans for body"). A lone sans-serif is the body font; anything else leads.
 */
export function ownerFonts(value: string): { heading?: string; body?: string } {
  const pair = value.match(/Fonts:\s*(.+?) for headings, (.+?) for body/i);
  if (pair) return { heading: resolveFont(pair[1], "Fraunces").font, body: resolveFont(pair[2], "Inter").font };
  const named = fontsNamedIn(value);
  if (!named.length) return {};
  if (named.length >= 2) {
    // "Inter for body and Fraunces for headlines": follow the words when they say which is which.
    const bodyFirst = new RegExp(`${named[0]!.family}[^.,;]{0,20}\\b(body|text|paragraph)`, "i").test(value) || new RegExp(`(head|title|display)[^.,;]{0,30}${named[1]!.family}`, "i").test(value);
    const [h, b] = bodyFirst ? [named[1]!, named[0]!] : [named[0]!, named[1]!];
    return { heading: h.family, body: b.family };
  }
  const only = named[0]!;
  const saysBody = /\b(body|paragraph|text font|small text)\b/i.test(value);
  const saysHead = /\b(head(line|ing)s?|titles?|display|wordmark)\b/i.test(value);
  if (saysBody && !saysHead) return { body: only.family };
  if (saysHead && !saysBody) return { heading: only.family };
  return only.category === "sans-serif" || only.category === "monospace" ? { body: only.family } : { heading: only.family };
}

function pickFonts(items: IntakeItem[], notes: string[], uploaded: UploadedFont[] = []) {
  // The owner's answers, latest last; a later answer that names only one role keeps the other.
  const answers = items.filter((i) => i.label.toLowerCase().trim().startsWith("fonts")).map((i) => ownerFonts(i.value));
  const owner = answers.reduce<{ heading?: string; body?: string }>((acc, a) => ({ ...acc, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v)) }), {});
  // Uploaded font files come next: a serif or display face leads, a sans sets the body.
  const files = uploaded.map((u) => ({ ...u, category: googleFont(u.family)?.category ?? null }));
  const fileHeading = files.find((f) => f.category && f.category !== "sans-serif" && f.category !== "monospace") ?? (files.length >= 2 ? files[0] : files.find((f) => !f.category));
  const fileBody = files.find((f) => f !== fileHeading && (f.category === "sans-serif" || f.category === "monospace" || !f.category)) ?? files.find((f) => f !== fileHeading);
  const headingText = lastItem(items, "type: heading")?.value;
  const bodyText = lastItem(items, "type: body")?.value;

  const heading: ResolvedFont = owner.heading
    ? { font: owner.heading, standIn: false, category: googleFont(owner.heading)?.category ?? "serif" }
    : fileHeading
      ? { font: fileHeading.family, standIn: false, category: fileHeading.category ?? "serif" }
      : resolveFont(headingText, "Fraunces");
  let body: ResolvedFont = owner.body
    ? { font: owner.body, standIn: false, category: googleFont(owner.body)?.category ?? "sans-serif" }
    : fileBody
      ? { font: fileBody.family, standIn: false, category: fileBody.category ?? "sans-serif" }
      : resolveFont(bodyText, "Inter");
  // A handwriting face is for a word or two, never for sentences people must read on a phone.
  if (body.category === "handwriting") {
    notes.push(`Body text: ${body.font} is a handwriting face, so posts set body text in Inter and keep ${body.font} for hand-written notes.`);
    body = { font: "Inter", standIn: false, category: "sans-serif" };
  }
  // The wordmark follows the headings unless the kit names a different face for it.
  const wordmarkNamed = fontsNamedIn(lastItem(items, "type: wordmark")?.value ?? "")[0]?.family;
  const wordmark = owner.heading || fileHeading ? heading.font : (wordmarkNamed ?? heading.font);
  const handItem = items.find((i) => i.label.toLowerCase().startsWith("type") && /\b(script|handwritten|handwriting|hand-?lettered|marker|brush)\b/i.test(firstSentenceOf(i.value)));
  const hand = heading.category === "handwriting" ? heading.font : handItem ? resolveFont(handItem.value, "Caveat").font : body.font;
  for (const [role, r, item] of [["Headings", heading, headingText], ["Body text", body, bodyText]] as const) {
    if (r.standIn && item) notes.push(`${role}: "${item.slice(0, 60)}" names no font, so posts use ${r.font}, the closest free match.`);
  }
  for (const f of uploaded.filter((u) => !u.google && [heading.font, body.font].includes(u.family))) notes.push(`${f.family} is set from the font file you uploaded.`);
  return { heading: heading.font, body: body.font, wordmark, hand };
}

const firstSentenceOf = (s: string) => s.split(/(?<=[.;])\s+/)[0] ?? s;

// ---------- files ----------

/** The owner's logo size, as a share of the standard (1 = 3.2em tall), from a "Logo size: 130%…" answer. */
export function logoScaleOf(items: IntakeItem[]): number {
  const v = [...items].reverse().find((i) => /^logo size:/i.test(i.value.trim()))?.value;
  const pct = Number(v?.match(/(\d{2,3})\s*%/)?.[1]);
  return pct ? Math.min(200, Math.max(50, pct)) / 100 : 1;
}

export function buildTokensCss(colors: SessionKit["colors"], fonts: SessionKit["fonts"], logoScale = 1): string {
  const font = (f: string) => `"${f}", system-ui, sans-serif`;
  const headingWeight = headingWeightOf(fonts.heading);
  const lines = [
    `  --color-background: ${colors.background};`,
    `  --color-text: ${colors.text};`,
    `  --color-heading: ${colors.heading};`,
    `  --color-accent: ${colors.accent};`,
    `  --color-label: ${colors.label};`,
    ...(colors.accent2 ? [`  --color-accent-2: ${colors.accent2};`] : []),
    `  --font-wordmark: ${font(fonts.wordmark)};`,
    `  --weight-wordmark: ${headingWeightOf(fonts.wordmark)};`,
    `  --tracking-wordmark: 0;`,
    `  --wordmark-line2-tracking: 0.3em;`,
    `  --wordmark-line2-scale: 0.45;`,
    `  --font-heading: ${font(fonts.heading)};`,
    `  --weight-heading: ${headingWeight};`,
    `  --tracking-heading: -0.01em;`,
    `  --min-size-heading: 56px;`,
    `  --font-body: ${font(fonts.body)};`,
    `  --weight-body: 400;`,
    `  --leading-body: 1.4;`,
    `  --min-size-body: 30px;`,
    `  --font-hand: ${font(fonts.hand)};`,
    `  --weight-hand: 400;`,
    `  --min-size-hand: 40px;`,
    `  --radius: 0px;`,
    `  --stamp-rotation: -3deg;`,
    `  --safe-margin: 80px;`,
    `  --unit: 8px;`,
    ...(logoScale !== 1 ? [`  --logo-height: ${+(3.2 * logoScale).toFixed(2)}em;`] : []),
    `  --role-background: var(--color-background);`,
    `  --role-text: var(--color-text);`,
    `  --role-heading: var(--color-heading);`,
    `  --role-accent: var(--color-accent);`,
    `  --role-wordmark: var(--color-heading);`,
    `  --role-label: var(--color-label);`,
    ...(colors.accent2 ? [`  --role-accent-2: var(--color-accent-2);`] : []),
  ];
  // A headline color the owner picked wins over whatever role a layout gave its headline.
  const pinned = colors.headingPinned ? `.headline, [data-slot="headline"] { color: var(--color-heading) !important; }\n` : "";
  return `/* Built by Specs from this kit's visual-system chunk. */\n:root {\n${lines.join("\n")}\n}\n${pinned}`;
}

const RETRIEVAL_RULES = `# Which chunks load for each job. Built by Specs for a kit drafted from uploads.
version: 1
profiles:
  post_generate:
    always: [voice-core, visual-system, art-direction, social-rules, terminology]
    if_relevant:
      - chunk: positioning-core
        when: The post states a fact (offer, price, date, place).
      - chunk: voice-examples
        when: Always useful for headlines; drop first if over budget.
      - chunk: audience
        when: The brief is about winning new customers (promo, announcement).
      - chunk: guardrails
        when: Promo, testimonial, tip, or any post that makes a claim.
    budget: 3000
  post_critique:
    always: [voice-core, art-direction, guardrails, social-rules]
    if_relevant:
      - chunk: terminology
        when: The copy names the brand's own things.
      - chunk: positioning-core
        when: The copy states a fact that needs checking.
    budget: 2000
`;

/** The kit a session's posts are made from, built from its drafted (and intake-answered) chunks. */
export function kitFromChunks(chunks: IntakeChunks, business: { name: string; fonts?: UploadedFont[] }): SessionKit {
  const notes: string[] = [];
  const visual = chunks["visual-system"]?.draft.items ?? [];
  const colors = pickColors(visual, notes);
  const fonts = pickFonts(visual, notes, business.fonts);
  const files: Record<string, string> = {};
  const ids: ExtractChunkId[] = [];
  for (const { id } of EXTRACT_CHUNKS) {
    const draft = chunks[id]?.draft;
    if (!draft) continue;
    files[`${id}.md`] = renderChunk(id, draft);
    ids.push(id);
  }
  // The pipeline's profile always loads these; an empty chunk beats a crash when one wasn't drafted.
  for (const id of ["voice-core", "visual-system", "art-direction", "social-rules", "terminology"] as const) {
    if (!files[`${id}.md`]) files[`${id}.md`] = `---\nchunk_id: ${id}\nconfidence: needs-review\nsummary: >-\n  Not drafted; nothing in the uploads covered it.\n---\n`;
  }
  const logoScale = logoScaleOf(visual);
  const tokensCss = buildTokensCss(colors, fonts, logoScale);
  files["tokens.css"] = tokensCss;
  files["_retrieval-rules.yaml"] = RETRIEVAL_RULES;
  files["readme.md"] = [
    "---",
    "chunk_id: readme",
    "confidence: medium",
    "summary: >-",
    `  The brand kit for ${business.name.replace(/\n/g, " ")}, drafted by Specs from the owner's uploads and answers.`,
    "---",
    "",
    `# ${business.name} brand kit`,
    "",
    "Drafted by Specs from the owner's uploads, then checked with the owner. Each chunk is one idea; every item says which upload it came from.",
    "",
    "## Chunks",
    "",
    ...ids.map((id) => `- \`${id}.md\`: ${EXTRACT_CHUNKS.find((c) => c.id === id)!.title}`),
    "- `tokens.css`: colors and fonts as CSS variables, built from visual-system",
    "",
    "## Colors and fonts in posts",
    "",
    `Background ${colors.background}, body text ${colors.text}, headings ${colors.heading}, accent ${colors.accent}${colors.accent2 ? `, second accent ${colors.accent2}` : ""}. Headings in ${fonts.heading}, body in ${fonts.body}.${logoScale !== 1 ? ` Logo at ${Math.round(logoScale * 100)}% of the standard size.` : ""}`,
    ...(notes.length ? ["", ...notes.map((n) => `- ${n}`)] : []),
    "",
  ].join("\n");
  return { files, tokensCss, wordmarkLines: [business.name], colors, fonts, notes };
}

/** The business's name, from the positioning facts list, or null when no upload gave it. */
export function businessNameOf(chunks: IntakeChunks): string | null {
  const item = lastItem(chunks["positioning-core"]?.draft.items ?? [], "fact: business_name", "fact: business name", "fact: name", "business_name", "name");
  const name = item?.value
    .split(/\n/)[0]!
    // The model sometimes tacks where it found the name onto the value ("SŌMA (printed on the box front…)").
    // The wordmark is set from this, so keep only the name itself.
    .replace(/\s+(\(|\[|[—–]\s|-\s|;\s).*$/, "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/[,:;.]+$/, "")
    .trim();
  return name ? name.slice(0, 60) : null;
}

/** The Google Fonts stylesheet for a kit's fonts, for rendering its posts in the browser. Any Google font loads by name. */
export function googleFontsHref(fonts: string[]): string {
  return hrefFor(fonts);
}
