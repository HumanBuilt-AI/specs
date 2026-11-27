"use client";

// Make something (build plan "Specs: new kit flow", Nov 27) from the visitor's own kit: pick the
// output (Poster 11×17, Story 9:16 or Instagram 1:1), say what it's for, and Specs writes the copy
// from the kit (plan, then write), then paints it (app/build/poster-card.tsx follows the job). Every
// output is painted the same way; the instant HTML post and "Make it bolder" are gone. A post type
// is optional.
import { useCallback, useEffect, useState } from "react";
import { LIMITS, POST_INTENTS, charCount, type PostIntent } from "../../core/limits.ts";
import { buildComposedPage, TEXT_SLOTS, type TextSlot } from "../../core/compose.ts";
import { OUTPUTS, OUTPUT_FORMATS, type OutputFormat } from "../../core/outputs.ts";
import type { TemplateId } from "../../core/templates.ts";
import { call, callAgainIfDropped, isDropped } from "../lib/api.ts";
import { withFontFiles } from "../lib/fonts.ts";
import { logoDataUrl, useLogoFor } from "../lib/logo.ts";
import { KitDownload } from "../ui/KitDownload.tsx";
import { Working } from "../ui/working.tsx";
import { PosterCard } from "./poster-card.tsx";
import { PRINT_TEXTURE_CSS } from "../../core/print.ts";

type Note = { decision: string; choice: string; reason: string; cites: string[] };
type Kit = {
  businessName: string;
  files: Record<string, string>;
  tokensCss: string;
  wordmarkLines: string[];
  fontsHref: string;
  photos: { file: string; uploadId?: string }[];
  logoUploadId: string | null;
  fontFiles?: { uploadId: string; family: string; ext: "ttf" | "otf" | "woff" | "woff2" }[];
};
type Slots = Record<string, string | null>;
type Made = {
  id: string;
  /** Stays the same when the server's id replaces the temporary one, so the card isn't remounted. */
  uid: string;
  format: OutputFormat;
  goal: string;
  stage: string | null;
  error?: string;
  /** The written copy and photo, for the backup version if no painting passes. */
  copy?: { slots: Record<TextSlot, string | null>; photo: { src: string; alt: string } | null };
};

const INTENT_LABEL: Record<PostIntent, string> = { promo: "Promo", announcement: "Announcement", event: "Event", testimonial: "Testimonial", tip: "Tip" };
const messageOf = (e: unknown) => (isDropped(e) ? "The connection dropped before this came back. Try making it again." : e instanceof Error ? e.message : "Something went wrong.");

export default function MakePosts({ sessionId, kitVersion = 0 }: { sessionId: string; kitVersion?: number }) {
  const [kit, setKit] = useState<Kit | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [logoRaw, setLogo] = useState<string | null>(null);
  // A logo that would vanish on the kit's background is shown as a knockout.
  const logo = useLogoFor(logoRaw, kit?.tokensCss);
  const [format, setFormat] = useState<OutputFormat>("poster");
  const [intent, setIntent] = useState<PostIntent | null>(null);
  const [goal, setGoal] = useState("");
  const [details, setDetails] = useState("");
  const [made, setMade] = useState<Made[]>([]);
  const [left, setLeft] = useState<number>(LIMITS.postersPerSession);
  const [busy, setBusy] = useState(false);

  const loadKit = useCallback(async () => {
    setKitError(null);
    try {
      const k = await withFontFiles(sessionId, await call<Kit>("/api/kit/files", { sessionId }));
      setKit(k);
      // Photos travel as data URLs, so the backup version's PNG export carries them too.
      const urls: Record<string, string> = {};
      for (const p of k.photos) {
        if (!p.uploadId) continue;
        const res = await fetch("/api/uploads/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, uploadId: p.uploadId }) });
        if (res.ok) urls[p.file] = await dataUrl(await res.blob());
      }
      setPhotos(urls);
      if (k.logoUploadId) setLogo(await logoDataUrl(sessionId, k.logoUploadId));
    } catch (e) {
      setKitError(messageOf(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void loadKit();
  }, [loadKit]);

  // The kit changed (a chat change, an answer): reload it, so the next output uses it.
  const [seenVersion, setSeenVersion] = useState(kitVersion);
  useEffect(() => {
    if (kitVersion === seenVersion) return;
    setSeenVersion(kitVersion);
    void loadKit();
  }, [kitVersion, seenVersion, loadKit]);

  const patch = (id: string, change: Partial<Made>) => setMade((ms) => ms.map((m) => (m.id === id ? { ...m, ...change } : m)));

  async function make() {
    if (!kit) return;
    setBusy(true);
    const tempId = crypto.randomUUID();
    const brief = { goal: goal.trim(), details: details.trim() };
    const chosen = format;
    setMade((ms) => [{ id: tempId, uid: tempId, format: chosen, goal: brief.goal, stage: "Writing the words from your kit…" }, ...ms]);
    let id = tempId;
    try {
      // The words come from the kit and the brief (plan, then write); the painter only paints them.
      const planned = await call<{ postId: string; plan: { template: TemplateId; photo: string | null; angle: string; rationale: Note[] } }>("/api/posts", {
        sessionId,
        brand: "session",
        // A post type is optional; without one, the copy is written as an announcement.
        intent: intent ?? "announcement",
        brief,
      });
      id = planned.postId;
      setMade((ms) => ms.map((m) => (m.id === tempId ? { ...m, id } : m)));
      setGoal("");
      setDetails("");
      // Writing twice returns the first answer, so a dropped connection is simply tried again.
      const written = await callAgainIfDropped<{ template: TemplateId; photo: string | null; slots: Slots }>("/api/posts/write", { sessionId, postId: id });
      const photoSrc = written.photo ? (photos[written.photo] ?? null) : null;
      const alt = `${kit.businessName}: ${written.slots.headline ?? written.slots.quote ?? ""}`.slice(0, 200);
      patch(id, { stage: null, copy: { slots: Object.fromEntries(TEXT_SLOTS.map((k) => [k, written.slots[k] ?? null])) as Record<TextSlot, string | null>, photo: photoSrc ? { src: photoSrc, alt } : null } });
    } catch (e) {
      patch(id, { stage: null, error: messageOf(e) });
    } finally {
      setBusy(false);
    }
  }

  const tooLong = charCount(goal) > LIMITS.messageChars || charCount(details) > LIMITS.messageChars;

  return (
    <section className="make-posts">
      <h2>
        Make something. <span>Painted from your kit, every word checked.</span>
      </h2>
      {kitError && (
        <p className="error">
          {kitError}{" "}
          <button type="button" className="link" onClick={() => void loadKit()}>
            Try again
          </button>
        </p>
      )}
      {kit && (
        <>
          <div className="card posts-kit">
            <div>
              <p className="eyebrow">Your brand kit</p>
              <p>
                {Object.keys(kit.files).length} files, ready to drop into any AI tool or hand to a freelancer. Everything below is made
                from it.
              </p>
            </div>
            <KitDownload slug={kit.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "brand"} name={kit.businessName} files={kit.files} />
          </div>

          <form
            className="card make-brief"
            onSubmit={(e) => {
              e.preventDefault();
              void make();
            }}
          >
            <div className="output-picker" role="radiogroup" aria-label="What to make">
              {OUTPUT_FORMATS.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={format === f} className="output-choice" onClick={() => setFormat(f)}>
                  <span className="output-thumb" style={{ aspectRatio: OUTPUTS[f].css }} aria-hidden="true" />
                  <b>{OUTPUTS[f].label}</b>
                  <span className="muted small">{OUTPUTS[f].use}</span>
                </button>
              ))}
            </div>
            <label htmlFor="make-goal">What should it do?</label>
            <input id="make-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Get people to the holiday listening party" />
            <label htmlFor="make-details">The true details</label>
            <textarea id="make-details" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="The date, the time, the offer. Only what's true." />
            <span className="muted small">What kind of piece, if it helps (optional)</span>
            <div className="c-seg c-seg-optional" role="radiogroup" aria-label="What kind of piece (optional)">
              {POST_INTENTS.map((i) => (
                <button key={i} type="button" role="radio" aria-checked={intent === i} onClick={() => setIntent(intent === i ? null : i)}>
                  {INTENT_LABEL[i]}
                </button>
              ))}
            </div>
            <div className="c-row-between">
              <span className="muted small">
                {left} of {LIMITS.postersPerSession} left this visit
              </span>
              <button type="submit" aria-busy={busy} disabled={busy || !goal.trim() || tooLong || left <= 0}>
                {busy ? "Writing…" : `Make the ${OUTPUTS[format].label.toLowerCase()}`}
              </button>
            </div>
          </form>

          <div className="posts-grid">
            {made.map((m) => (
              <article key={m.uid} data-post-id={m.id} className="posts-item">
                <header>
                  <span className="eyebrow">{OUTPUTS[m.format].label}</span>
                  <p className="posts-goal">{m.goal}</p>
                  {m.stage && <Working kind="making" lead={m.stage} />}
                  {m.error && <p className="error small">{m.error}</p>}
                </header>
                {m.copy && (
                  <PosterCard
                    sessionId={sessionId}
                    postId={m.id}
                    format={m.format}
                    logo={logo}
                    onStart={() => setLeft((n) => Math.max(0, n - 1))}
                    pageForB={(b) =>
                      buildComposedPage({ composition: { html: b.html, css: b.css }, slots: m.copy!.slots, aspect: "1:1", tokensCss: kit.tokensCss, fontsHref: kit.fontsHref, wordmarkLines: kit.wordmarkLines, logoSrc: logo, photo: b.usesPhoto ? m.copy!.photo : null }).replace("</head>", `<style>${PRINT_TEXTURE_CSS}</style></head>`)
                    }
                  />
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
