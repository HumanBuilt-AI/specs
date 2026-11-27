"use client";

// A painted output (build plan "Specs: new kit flow", Nov 27): poster, story or Instagram post.
// The server paints a quick first look and the final side by side with an image model, reads every
// word back and checks the photo; this card follows the job. The first look shows as soon as it
// passes, and the final replaces it. Code trims the painting to the output's shape and sets the
// owner's real logo in the logo spot. When nothing passed on a square, the server builds the
// backup (a painted plate with no text) and this card sets the real type over it.
import { useEffect, useState } from "react";
import { call, type ApiError } from "../lib/api.ts";
import { withPlate } from "../../core/print.ts";
import { logoRect } from "../../core/poster.ts";
import { OUTPUTS, cropOf, type OutputFormat } from "../../core/outputs.ts";
import { Working } from "../ui/working.tsx";
import { Thumb } from "./bold-version.tsx";
import { logoOnBackground } from "../lib/logo.ts";

type Attempt = { n: number; quality?: "low" | "high"; pass: boolean; problems: string[]; model: string; seconds: number };
export type PosterB = { html: string; css: string; usesPhoto: boolean; rationale: { decision: string; choice: string; reason: string; cites: string[] }[]; plateMediaType: string };
type Job = {
  status: "painting" | "checking" | "done" | "fallback" | "b_ready" | "failed";
  stage: string;
  attempts: Attempt[];
  result?: { attempt: number; mediaType: string };
  firstLook?: { attempt: number; mediaType: string };
  b?: PosterB;
  error?: string;
};

const POLL_MS = 5000;

/** The bytes a poster route answers with, as a data URL (so a sandboxed frame and a download can both use it). */
async function fetchDataUrl(path: string, body: unknown): Promise<string> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("The poster couldn't be loaded.");
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("The poster couldn't be loaded."));
    r.readAsDataURL(blob);
  });
}

/**
 * The painting trimmed to the output's shape, with the owner's real logo set in the logo spot (the
 * painter leaves it as plain paper). The logo is checked against the spot it actually lands on, not
 * the kit's background: Scott's first live poster had a cream patch there, and the knockout made for
 * the plum background turned the logo white on cream (Nov 27).
 */
async function finish(painted: string, logo: string | null, format: OutputFormat, look: { text: string | null; scale: number }): Promise<string> {
  try {
    const art = new Image();
    art.src = painted;
    await art.decode();
    const c = cropOf(format, art.naturalWidth, art.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = c.w;
    canvas.height = c.h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(art, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    if (logo) {
      const mark = new Image();
      mark.src = logo;
      await mark.decode();
      const r = logoRect(c.w, c.h, mark.naturalWidth, mark.naturalHeight, look.scale);
      const shown = await logoOnBackground(logo, spotColor(ctx, r), look.text);
      const ink = new Image();
      ink.src = shown;
      await ink.decode();
      ctx.drawImage(ink, r.x, r.y, r.w, r.h);
    }
    return canvas.toDataURL("image/png");
  } catch {
    return painted;
  }
}

/** The average color of the painting where the logo goes. */
function spotColor(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): string {
  const px = ctx.getImageData(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h)).data;
  let red = 0, green = 0, blue = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) {
    red += px[i]!;
    green += px[i + 1]!;
    blue += px[i + 2]!;
    n++;
  }
  const hex = (v: number) => Math.round(v / Math.max(1, n)).toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/** A full-size PNG of a page, for the backup version's download. */
async function pngOf(page: string, aspect: "1:1" | "4:5"): Promise<string | null> {
  const h = aspect === "4:5" ? 1350 : 1080;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:1080px;height:${h}px;border:0;visibility:hidden`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
      frame.srcdoc = page;
    });
    const doc = frame.contentDocument!;
    await doc.fonts?.ready;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
    const post = doc.querySelector<HTMLElement>(".post");
    if (!post) return null;
    const { toPng } = await import("html-to-image");
    const { embeddedFontCss } = await import("../ui/catalog/PostPreview.tsx");
    return await toPng(post, { width: 1080, height: h, pixelRatio: 1, cacheBust: false, fontEmbedCSS: await embeddedFontCss(doc) });
  } catch {
    return null;
  } finally {
    frame.remove();
  }
}

export function PosterCard(props: {
  sessionId: string;
  postId: string;
  format: OutputFormat;
  /** The owner's logo as uploaded; code sets it on the painting, knocked out only if it would vanish on that spot. */
  logo: string | null;
  /** The kit's text color (for a knockout) and the owner's logo size (1 = standard). */
  look: { text: string | null; scale: number };
  /** Builds a full post page from the backup's type layer, with this post's copy, photo and kit look. */
  pageForB: (b: PosterB) => string;
  /** Called once the job has started (or the visit's outputs turn out to be used up). */
  onStart: () => void;
}) {
  const { sessionId, postId, format, logo, look, pageForB, onStart } = props;
  const lookKey = `${look.text}|${look.scale}`;
  const aspect = "1:1" as const; // the backup is built for the square only
  const label = OUTPUTS[format].label.toLowerCase();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [firstRaw, setFirstRaw] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);

  // Follow the job. Browsers pause timers in a hidden tab, so coming back checks at once.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "b_ready" || job.status === "failed") return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      stopped = true;
      try {
        setJob(await call<Job>("/api/posters/status", { sessionId, postId }, { timeoutMs: 15_000 }));
      } catch {
        setJob((j) => (j ? { ...j } : j));
      }
    };
    const t = setTimeout(() => void poll(), POLL_MS);
    const onShow = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      stopped = true;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [job, sessionId, postId]);

  // A painting passed: fetch it.
  useEffect(() => {
    if (job?.status !== "done" || painted) return;
    fetchDataUrl("/api/posters/image", { sessionId, postId }).then(setPainted, (e: Error) => setError(e.message));
  }, [job, painted, sessionId, postId]);
  // The first look, as soon as it passed, while the final paints.
  useEffect(() => {
    if (!job?.firstLook || firstRaw || job.status === "done") return;
    fetchDataUrl("/api/posters/image", { sessionId, postId, which: "first" }).then(setFirstRaw, () => {});
  }, [job, firstRaw, sessionId, postId]);
  // Trim each to the output's shape and set the real logo on it (again, if the logo arrives or changes later).
  useEffect(() => {
    let live = true;
    if (painted) void finish(painted, logo, format, look).then((x) => live && setImage(x));
    if (firstRaw) void finish(firstRaw, logo, format, look).then((x) => live && setFirst(x));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [painted, firstRaw, logo, format, lookKey]);

  // Start as soon as the card appears: the owner already chose the output.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked) return;
    setAsked(true);
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  // The backup: fetch the plate, set the real type over it, and make the download.
  useEffect(() => {
    if (job?.status !== "b_ready" || !job.b || page) return;
    const b = job.b;
    fetchDataUrl("/api/posters/plate", { sessionId, postId })
      .then(async (plate) => {
        const p = withPlate(pageForB(b), plate);
        setPage(p);
        setDownload(await pngOf(p, aspect));
      })
      .catch((e: Error) => setError(e.message));
  }, [job, page, pageForB, aspect, sessionId, postId]);

  async function start() {
    setError(null);
    try {
      setJob(await call<Job>("/api/posters/start", { sessionId, postId, format }));
      onStart();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "poster_cap") onStart();
      setError(err.message ?? `The ${label} couldn't start.`);
    }
  }

  if (!job && !error) return <Working kind="making" lead={`Starting your ${label}…`} />;
  if (!job)
    return (
      <div className="bold-offer">
        <p className="error small">{error}</p>
      </div>
    );
  if (error || job.status === "failed")
    return (
      <div className="bold-offer">
        <p className="error small">{error ?? `The ${label} stopped partway. Nothing was used up, so you can try again.`}</p>
        {!error && job.error && <p className="muted small">What went wrong: {job.error}</p>}
        {!error && (
          <button type="button" className="c-btn" onClick={() => void start()}>
            Try again
          </button>
        )}
      </div>
    );

  const shape = { aspectRatio: OUTPUTS[format].css };
  const file = `${format}.png`;
  const Label = OUTPUTS[format].label;

  if (job.status === "done") {
    const repainted = job.attempts.some((a) => a.n === 3);
    const quickWon = job.result?.attempt === 1;
    return (
      <figure className="poster-result">
        <div className="bold-thumb" style={shape}>
          {image ? <img src={image} alt={`Your ${label}, painted from your kit`} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Working kind="making" lead={`Loading your ${label}…`} />}
        </div>
        <figcaption>
          <b>Your {label}</b>
          <span className="muted small">
            Painted with an image model, with your real logo set on top. Every word and your photo were checked against the kit.
            {quickWon ? " The detailed version missed a check, so this is the quick one." : repainted ? " The first painting missed a check, so it was repainted." : ""}
          </span>
          {image && (
            <a className="c-btn" href={image} download={file}>
              Download PNG
            </a>
          )}
        </figcaption>
      </figure>
    );
  }

  if (job.status === "b_ready") {
    const missed = job.attempts.flatMap((a) => a.problems).slice(0, 2);
    return (
      <figure className="poster-result">
        {page ? <Thumb html={page} aspect={aspect} /> : <Working kind="making" lead="Setting your type over the art…" />}
        <figcaption>
          <b>Your {label}</b>
          <span className="muted small">
            The painted versions didn't pass the checks{missed.length ? ` (${missed.join("; ")})` : ""}, so this one sets your real type, logo and photo over painted art.
          </span>
          {download && (
            <a className="c-btn" href={download} download={file}>
              Download PNG
            </a>
          )}
        </figcaption>
      </figure>
    );
  }

  const lead = job.status === "fallback" ? "Building a backup version…" : job.attempts.some((a) => a.n === 2 && !a.pass) ? "Repainting what didn't pass…" : first ? "Painting the final version…" : "Painting a first look…";
  return (
    <figure className="poster-result">
      <div className="bold-thumb" style={shape} data-first-look={first ? "true" : undefined}>
        {first ? <img src={first} alt={`A first look at your ${label}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Working kind="making" lead={lead} />}
      </div>
      <figcaption>
        <b>{first ? "First look" : Label}</b>
        <span className="muted small">
          {first ? `${lead.replace("…", "")}. It replaces this when it's done, in about half a minute.` : "Painting takes about 20 seconds for a first look and under a minute for the final. You can keep working."}
        </span>
      </figcaption>
    </figure>
  );
}
