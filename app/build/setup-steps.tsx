"use client";

// The upload screen, one step at a time (Scott, Nov 26): everything goes in first (logo, photos,
// notes, a PDF, the website, a few words; Scott, Nov 27: notes came last, so a .txt of palettes and
// fonts never reached Colors and Fonts), then a palette by role, then fonts with a live preview,
// then references. The visual steps are instant, and the uploads are read in the background while
// the owner works through them, so most of the reading wait is hidden.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PALETTE_ROLES, ROLE_TEXT, contrastOf, paletteCandidates, suggestPalette, typedHexes, type Candidate, type ColorSource, type PaletteRole } from "../../core/picks.ts";
import { googleFamilies, googleFont, googleFontsHref } from "../../core/fonts.ts";
import { LIMITS } from "../../core/limits.ts";
import { LOGO_ACCEPT, isSvg, logoProblem } from "../lib/images.ts";

export type SetupStage = "photos" | "colors" | "fonts" | "references" | "built";
export const SETUP_STEPS: { id: Exclude<SetupStage, "built">; name: string }[] = [
  { id: "photos", name: "Your files" },
  { id: "colors", name: "Colors" },
  { id: "fonts", name: "Fonts" },
  { id: "references", name: "References" },
];

/** Same name and size: the same file dropped twice. */
export const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size;
export const addFiles = (have: File[], more: File[], cap: number) => [...have, ...more.filter((f) => !have.some((h) => sameFile(h, f)))].slice(0, cap);

export function StepRail({ stage, reading }: { stage: SetupStage; reading?: { done: number; total: number } }) {
  const at = SETUP_STEPS.findIndex((s) => s.id === stage);
  return (
    <div className="step-rail" aria-label="Steps">
      <ol>
        {SETUP_STEPS.map((s, i) => (
          <li key={s.id} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
            <span className="mono">{i + 1}</span> {s.name}
          </li>
        ))}
      </ol>
      {reading && reading.total > 0 && (
        <p className="muted small step-reading">
          {reading.done < reading.total ? `Reading your files in the background: ${reading.done} of ${reading.total}` : "Files read"}
        </p>
      )}
    </div>
  );
}

// ---------- 1. photos ----------

export function PhotosStep(props: {
  logo: File | null;
  photos: File[];
  heroes: number[];
  url: string;
  onUrl: (u: string) => void;
  busy: boolean;
  onLogo: (f: File | null) => void;
  onPhotos: (f: File[]) => void;
  onHeroes: (h: number[]) => void;
  onError: (m: string | null) => void;
  /** Files that aren't photos or a logo (text files, a PDF): the words part of this step takes them. */
  onOther: (files: File[]) => string | null;
  /** Anything to read besides photos (notes, a PDF, pasted words), for the button's label. */
  hasWords: boolean;
  blocked?: boolean;
  children?: ReactNode;
  onNext: () => void;
}) {
  const { logo, photos, heroes, busy } = props;
  const [dragging, setDragging] = useState(false);
  const thumbs = useMemo(() => photos.map((p) => URL.createObjectURL(p)), [photos]);
  const logoThumb = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo]);
  useEffect(() => () => thumbs.forEach(URL.revokeObjectURL), [thumbs]);
  useEffect(() => () => void (logoThumb && URL.revokeObjectURL(logoThumb)), [logoThumb]);

  function take(files: File[]) {
    const logoLike = !logo ? files.find((f) => isSvg(f) || (/^image\//.test(f.type) && /logo|wordmark|lockup/i.test(f.name))) : undefined;
    const images = files.filter((f) => f !== logoLike && /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/.test(f.type));
    const design = files.map(logoProblem).find(Boolean);
    if (logoLike) props.onLogo(logoLike);
    if (images.length) props.onPhotos(addFiles(photos, images, LIMITS.imageCount));
    const other = files.filter((f) => f !== logoLike && !images.includes(f) && !logoProblem(f));
    const otherProblem = other.length ? props.onOther(other) : null;
    props.onError(design ?? otherProblem);
  }
  function pickLogo(f: File | null) {
    const problem = f && logoProblem(f);
    props.onError(problem || null);
    if (!problem) props.onLogo(f);
  }
  const toggleHero = (i: number) => props.onHeroes(heroes.includes(i) ? heroes.filter((h) => h !== i) : [...heroes, i].slice(-2));
  const remove = (i: number) => {
    props.onPhotos(photos.filter((_, j) => j !== i));
    props.onHeroes(heroes.filter((h) => h !== i).map((h) => (h > i ? h - 1 : h)));
  };

  return (
    <div className="card setup-step">
      <h2 className="step-title">
        Everything you have. <span>Messy is fine: that&rsquo;s the point.</span>
      </h2>
      <div
        className={`dropzone ${dragging ? "over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take([...e.dataTransfer.files]);
        }}
      >
        <p className="dropzone-title">Drop your logo, photos and notes here</p>
        <p className="muted small">SVG or PNG is best for the logo. Up to {LIMITS.imageCount} photos (three to five is plenty), text files with your colors and fonts, and one PDF.</p>
        <div className="dropzone-pick">
          <label htmlFor="logo" className="c-btn ghost">
            Choose a logo
          </label>
          <input id="logo" className="visually-hidden" type="file" accept={LOGO_ACCEPT} onChange={(e) => pickLogo(e.target.files?.[0] ?? null)} />
          <label htmlFor="photos" className="c-btn ghost">
            Choose photos
          </label>
          <input id="photos" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,.heic,.heif" multiple onChange={(e) => take([...(e.target.files ?? [])])} />
        </div>
      </div>

      {(logo || photos.length > 0) && (
        <div className="photo-grid">
          {logo && (
            <figure className="photo-tile logo-tile">
              {logoThumb && <img src={logoThumb} alt="" />}
              <figcaption>
                <span className="mono">Logo</span>
                <button type="button" className="quiet" onClick={() => props.onLogo(null)} aria-label={`Remove ${logo.name}`}>
                  Remove
                </button>
              </figcaption>
            </figure>
          )}
          {photos.map((p, i) => (
            <figure key={`${p.name}-${p.size}`} className={`photo-tile ${heroes.includes(i) ? "hero" : ""}`}>
              <img src={thumbs[i]} alt="" />
              <button type="button" className="star" aria-pressed={heroes.includes(i)} aria-label={`${heroes.includes(i) ? "Unstar" : "Star"} ${p.name} as a hero photo`} onClick={() => toggleHero(i)}>
                {heroes.includes(i) ? "★" : "☆"}
              </button>
              <figcaption>
                <span className="small">{p.name}</span>
                <button type="button" className="quiet" onClick={() => remove(i)} aria-label={`Remove ${p.name}`}>
                  Remove
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {photos.length > 0 && (
        <p className="star-hint small">
          <b>★ Star your best one or two.</b>
          <span className="muted">Starred photos lead every post Specs makes, and Specs won&rsquo;t ask you about photos later. The rest back them up.</span>
        </p>
      )}

      <label htmlFor="url">Website, if you have one</label>
      <input id="url" type="url" placeholder="https://" value={props.url} onChange={(e) => props.onUrl(e.target.value)} />
      <p className="counter">A site takes the longest to read, so Specs starts on it now, while you pick colors and fonts.</p>

      {props.children}

      <div className="step-actions">
        <button onClick={props.onNext} disabled={busy || props.blocked}>
          {logo || photos.length || props.url.trim() || props.hasWords ? "Next: colors" : "Skip: I have nothing yet"}
        </button>
      </div>
    </div>
  );
}

// ---------- 2. colors ----------

type Slot = { role: PaletteRole; hex: string | null };
const ink = (hex: string) => (contrastOf(hex, "#141414") >= contrastOf(hex, "#FFFFFF") ? "#141414" : "#FFFFFF");

export function ColorsStep(props: { sources: ColorSource[]; fromNotes?: string[]; busy: boolean; onDone: (palette: { role: PaletteRole; hex: string }[] | null) => void }) {
  // Hex codes in the owner's notes start in the box, so they lead the palette.
  const [pasted, setPasted] = useState((props.fromNotes ?? []).join(", "));
  const typed = typedHexes(pasted);
  const cands = useMemo(() => paletteCandidates(props.sources, typed), [props.sources, typed.join()]);
  const fresh = (): Slot[] => {
    const s = suggestPalette(cands);
    return PALETTE_ROLES.map((role) => ({ role, hex: s.find((x) => x.role === role)?.hex ?? null }));
  };
  const [slots, setSlots] = useState<Slot[]>(fresh);
  const [touched, setTouched] = useState(false);
  // The palette comes filled in. Tapping a color opens the other colors for that one role; picking one swaps it and closes (Scott, Nov 27: the pick-a-slot-then-tap step was confusing).
  const [editing, setEditing] = useState<PaletteRole | null>(null);
  // New colors (a photo sampled late, hex codes pasted) refresh the suggestion until the owner changes it.
  useEffect(() => {
    if (!touched) setSlots(fresh());
  }, [cands]); // eslint-disable-line react-hooks/exhaustive-deps

  const get = (r: PaletteRole) => slots.find((s) => s.role === r)?.hex ?? null;
  const assign = (hex: string) => {
    if (!editing) return;
    setTouched(true);
    setSlots((ss) => ss.map((s) => (s.role === editing ? { ...s, hex } : s)));
    setEditing(null);
  };
  const bg = get("background") ?? "#F5F3EF";
  const text = get("text") ?? ink(bg);
  const head = get("headings") ?? text;
  const accent = get("accent");
  const extra = get("extra");
  const faint = contrastOf(text, bg) < 4.5;
  const ready = !!get("background") && !!get("text");
  const palette = slots.filter((s): s is { role: PaletteRole; hex: string } => !!s.hex);

  return (
    <div className="card setup-step">
      <h2 className="step-title">
        Your colors. <span>Most used first.</span>
      </h2>
      <p className="muted">{cands.length ? "Here's a palette from your logo and photos. Tap any color to swap it." : "Paste your hex codes below, or skip and Specs will use what your files say."}</p>

      <div className="role-slots" aria-label="Your palette">
        {slots.map((s) => (
          <button
            key={s.role}
            type="button"
            aria-expanded={editing === s.role}
            className={`role-slot ${editing === s.role ? "active" : ""} ${s.hex ? "" : "empty"}`}
            onClick={() => setEditing(editing === s.role ? null : s.role)}
          >
            <span className="role-chip" style={s.hex ? { background: s.hex } : undefined} />
            <span className="role-name">{ROLE_TEXT[s.role].name}</span>
            <span className="muted small">{s.hex ?? ROLE_TEXT[s.role].hint}</span>
            <span className="small role-action">{editing === s.role ? "Close" : s.hex ? "Swap" : "Add"}</span>
          </button>
        ))}
      </div>

      {editing && (
        <div className="cand-panel">
          <p className="small">
            <b>{ROLE_TEXT[editing].name}:</b> pick one of your colors.
          </p>
          <div className="cand-grid" aria-label={`Colors for ${ROLE_TEXT[editing].name}`}>
            {cands.map((c: Candidate) => (
              <button key={c.hex} type="button" className={`cand ${get(editing) === c.hex ? "on" : ""}`} onClick={() => assign(c.hex)} aria-label={`${c.hex} from your ${c.from === "typed" ? "hex codes" : c.from}`}>
                <span className="cand-chip" style={{ background: c.hex }} />
                <span className="mono small">{c.hex}</span>
                <span className="muted small">{c.from === "typed" ? "yours" : c.from}</span>
              </button>
            ))}
            {!cands.length && <p className="muted small">No colors yet. Paste your hex codes below.</p>}
          </div>
          {editing === "extra" && extra && (
            <button type="button" className="quiet" onClick={() => (setTouched(true), setSlots((ss) => ss.map((s) => (s.role === "extra" ? { ...s, hex: null } : s))), setEditing(null))}>
              Remove the extra color
            </button>
          )}
        </div>
      )}

      <label htmlFor="hexes">Have exact colors? Paste hex codes</label>
      <input id="hexes" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="#361E39, #BE3042, #F4EBDD" />
      <p className="counter">{props.fromNotes?.length ? "From your notes. Hex codes here come first." : "Hex codes you paste come first."}</p>

      <div className="palette-preview" style={{ background: bg, color: text }} aria-label="Preview">
        <div style={{ color: head }} className="pp-head">
          Your headline
        </div>
        <div className="pp-body">Body text sits like this on your background.</div>
        {accent && (
          <span className="pp-pill" style={{ background: accent, color: ink(accent) }}>
            Accent
          </span>
        )}
        {extra && <span className="pp-dot" style={{ background: extra }} />}
      </div>
      {faint && <p className="small needs-call">Text is hard to read on this background ({contrastOf(text, bg).toFixed(1)}:1). Posts will use near-black or white for body text unless you pick a stronger color.</p>}

      <div className="step-actions">
        <button onClick={() => props.onDone(palette)} disabled={!ready || props.busy}>
          Use these colors
        </button>
        <button className="c-btn ghost" onClick={() => props.onDone(null)} disabled={props.busy}>
          Skip: let Specs decide
        </button>
      </div>
    </div>
  );
}

// ---------- 3. fonts ----------

const PAIRS: { heading: string; body: string; note: string }[] = [
  { heading: "Fraunces", body: "Inter", note: "Warm serif, plain sans" },
  { heading: "DM Serif Display", body: "Work Sans", note: "Classic and crisp" },
  { heading: "Archivo Black", body: "Libre Franklin", note: "Loud and blocky" },
];

export function FontsStep(props: {
  colors: { bg: string; text: string; head: string; accent: string | null };
  name: string;
  uploaded: { family: string; file?: File }[];
  busy: boolean;
  onUpload: (files: File[]) => void;
  /** Fonts the owner's notes name: Google fonts to start from, and names Google doesn't serve. */
  fromNotes?: { heading: string | null; body: string | null; unknown: string[] };
  onDone: (fonts: { heading: string; body: string } | null) => void;
}) {
  const { colors, uploaded } = props;
  const families = useMemo(googleFamilies, []);
  const noted = props.fromNotes;
  const start = uploaded.length >= 2
    ? { heading: uploaded[0]!.family, body: uploaded[1]!.family }
    : uploaded.length === 1
      ? { heading: uploaded[0]!.family, body: noted?.body ?? "Inter" }
      : noted?.heading || noted?.body
        ? { heading: noted.heading ?? noted.body!, body: noted.body ?? "Inter" }
        : PAIRS[0]!;
  const [heading, setHeading] = useState(start.heading);
  const [body, setBody] = useState(start.body);
  const [touched, setTouched] = useState(false);
  // A font file uploaded after the step opened leads, until the owner picks something else.
  useEffect(() => {
    if (touched || !uploaded.length) return;
    setHeading(uploaded[0]!.family);
    if (uploaded[1]) setBody(uploaded[1].family);
  }, [uploaded, touched]);

  // Uploaded files are drawn from the file itself; Google fonts load by name.
  useEffect(() => {
    for (const u of uploaded) {
      if (!u.file || googleFont(u.family)) continue;
      u.file
        .arrayBuffer()
        .then((buf) => new FontFace(u.family, buf).load())
        .then((f) => document.fonts.add(f))
        .catch(() => {});
    }
  }, [uploaded]);

  const known = (n: string) => !!googleFont(n) || uploaded.some((u) => u.family.toLowerCase() === n.trim().toLowerCase());
  const proper = (n: string) => uploaded.find((u) => u.family.toLowerCase() === n.trim().toLowerCase())?.family ?? googleFont(n)?.family ?? n.trim();
  const ok = known(heading) && known(body);
  const href = googleFontsHref([heading, body, ...PAIRS.flatMap((p) => [p.heading, p.body])].filter((n) => googleFont(n)));
  const set = (h: string, b: string) => (setTouched(true), setHeading(h), setBody(b));

  return (
    <div className="card setup-step">
      <link rel="stylesheet" href={href} />
      <h2 className="step-title">
        Your fonts. <span>Upload yours, or name any Google font.</span>
      </h2>
      {(noted?.heading || noted?.body) && !uploaded.length && <p className="muted">Your notes name {[noted.heading, noted.body].filter(Boolean).join(" and ")}, so they&rsquo;re picked to start.</p>}
      {!!noted?.unknown.filter((n) => !uploaded.some((u) => u.family.toLowerCase() === n.toLowerCase())).length && (
        <p className="small needs-call">
          Your notes name {noted.unknown.join(" and ")}, which {noted.unknown.length === 1 ? "isn't a free Google font" : "aren't free Google fonts"}. Upload the font {noted.unknown.length === 1 ? "file" : "files"} to use {noted.unknown.length === 1 ? "it" : "them"} exactly, or pick a close match below.
        </p>
      )}

      <div className="dropzone-pick" style={{ justifyContent: "flex-start" }}>
        <label htmlFor="fonts" className="c-btn ghost">
          Upload font files
        </label>
        <input id="fonts" className="visually-hidden" type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" multiple onChange={(e) => props.onUpload([...(e.target.files ?? [])])} />
        {uploaded.map((u) => (
          <span key={u.family} className="source">
            {u.family}
          </span>
        ))}
      </div>

      <div className="pair-grid">
        {[...(uploaded.length ? [{ heading: start.heading, body: start.body, note: "Your files" }] : noted?.heading || noted?.body ? [{ heading: start.heading, body: start.body, note: "From your notes" }] : []), ...PAIRS].filter((p, i, xs) => xs.findIndex((x) => x.heading === p.heading && x.body === p.body) === i).map((p) => (
          <button key={`${p.heading}/${p.body}`} type="button" className={`pair ${heading === p.heading && body === p.body ? "on" : ""}`} onClick={() => set(p.heading, p.body)} aria-pressed={heading === p.heading && body === p.body}>
            <span style={{ fontFamily: `"${p.heading}", serif`, fontSize: 24, lineHeight: 1.1 }}>{props.name || "Good things"}</span>
            <span style={{ fontFamily: `"${p.body}", sans-serif` }} className="small">
              Body text in {p.body}.
            </span>
            <span className="muted small mono">{p.note}</span>
          </button>
        ))}
      </div>

      <div className="font-names">
        <div>
          <label htmlFor="head-font">Headline font</label>
          <input id="head-font" list="google-fonts" value={heading} onChange={(e) => (setTouched(true), setHeading(e.target.value))} />
          {!known(heading) && heading.trim() && <p className="small needs-call">Not a Google font. Upload its file, or pick another.</p>}
        </div>
        <div>
          <label htmlFor="body-font">Body font</label>
          <input id="body-font" list="google-fonts" value={body} onChange={(e) => (setTouched(true), setBody(e.target.value))} />
          {!known(body) && body.trim() && <p className="small needs-call">Not a Google font. Upload its file, or pick another.</p>}
        </div>
        <datalist id="google-fonts">
          {[...uploaded.map((u) => u.family), ...families].map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div className="palette-preview" style={{ background: colors.bg, color: colors.text }} aria-label="Preview">
        <div className="pp-head" style={{ color: colors.head, fontFamily: `"${proper(heading)}", serif` }}>
          {props.name || "Your headline, set in your font"}
        </div>
        <div className="pp-body" style={{ fontFamily: `"${proper(body)}", sans-serif` }}>
          Body text reads like this: short lines, real facts, your own words.
        </div>
        {colors.accent && (
          <span className="pp-pill" style={{ background: colors.accent, color: ink(colors.accent), fontFamily: `"${proper(body)}", sans-serif` }}>
            Come say hi
          </span>
        )}
      </div>

      <div className="step-actions">
        <button onClick={() => props.onDone({ heading: proper(heading), body: proper(body) })} disabled={!ok || props.busy}>
          Use these fonts
        </button>
        <button className="c-btn ghost" onClick={() => props.onDone(null)} disabled={props.busy}>
          Skip: let Specs decide
        </button>
      </div>
    </div>
  );
}
