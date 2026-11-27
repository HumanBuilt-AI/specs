"use client";

// "Make a poster" (plan "Specs: posters in the app", Nov 27): once per visit, under a finished
// post. The server paints the poster in the background with an image model, reads every word back
// and checks the logo and the owner's photo; this card follows the job. A painting that passed is
// shown as it is. When two paintings failed, the server builds the backup (a painted plate with no
// text) and this card sets the post's real type over it, so every word is exact by construction.
import { useEffect, useState } from "react";
import { call, type ApiError } from "../lib/api.ts";
import { withPlate } from "../../core/print.ts";
import { Working } from "../ui/working.tsx";
import { Thumb } from "./bold-version.tsx";

type Attempt = { n: number; pass: boolean; problems: string[]; model: string; seconds: number };
export type PosterB = { html: string; css: string; usesPhoto: boolean; rationale: { decision: string; choice: string; reason: string; cites: string[] }[]; plateMediaType: string };
type Job = {
  status: "painting" | "checking" | "done" | "fallback" | "b_ready" | "failed";
  stage: string;
  attempts: Attempt[];
  result?: { attempt: number; mediaType: string };
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
  aspect: "1:1" | "4:5";
  /** Builds a full post page from the backup's type layer, with this post's copy, photo and kit look. */
  pageForB: (b: PosterB) => string;
  /** False once this visit's poster is used on another post. */
  available: boolean;
  onStart: () => void;
}) {
  const { sessionId, postId, aspect, pageForB, available, onStart } = props;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
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
    if (job?.status !== "done" || image) return;
    fetchDataUrl("/api/posters/image", { sessionId, postId }).then(setImage, (e: Error) => setError(e.message));
  }, [job, image, sessionId, postId]);

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
      setJob(await call<Job>("/api/posters/start", { sessionId, postId }));
      onStart();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "poster_cap") onStart();
      setError(err.message ?? "The poster couldn't start.");
    }
  }

  if (!job) {
    if (!available) return null;
    return (
      <div className="bold-offer">
        <button type="button" className="c-btn" onClick={() => void start()}>
          Make a poster
        </button>
        <p className="muted small">One per visit. An image model paints a printed poster from this post, then Specs checks every word, your logo and your photo before you see it. It takes a minute or two; keep going and it'll show up here.</p>
        {error && <p className="error small">{error}</p>}
      </div>
    );
  }
  if (error || job.status === "failed")
    return (
      <div className="bold-offer">
        <p className="error small">{error ?? "The poster stopped partway. Your post is unchanged."}</p>
        {!error && job.error && <p className="muted small">What went wrong: {job.error}</p>}
      </div>
    );

  if (job.status === "done") {
    const repainted = job.attempts.length > 1;
    return (
      <figure className="poster-result">
        <div className="bold-thumb" style={{ aspectRatio: aspect === "4:5" ? "4 / 5" : "1 / 1" }}>
          {image ? <img src={image} alt="The poster, painted from this post" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Working kind="making" lead="Loading the poster…" />}
        </div>
        <figcaption>
          <b>Your poster</b>
          <span className="muted small">
            Painted with an image model. Every word, your logo and your photo were checked against the kit.
            {repainted ? " The first painting missed a check, so it was repainted." : ""}
          </span>
          {image && (
            <a className="c-btn" href={image} download="poster.png">
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
          <b>Your poster</b>
          <span className="muted small">
            The painted versions didn't pass the checks{missed.length ? ` (${missed.join("; ")})` : ""}, so this one sets your real type, logo and photo over painted art.
          </span>
          {download && (
            <a className="c-btn" href={download} download="poster.png">
              Download PNG
            </a>
          )}
        </figcaption>
      </figure>
    );
  }

  const lead = job.status === "checking" ? "Reading every word back…" : job.status === "fallback" ? "Building a backup version…" : job.attempts.length ? "Repainting what didn't pass…" : "Painting the poster…";
  return (
    <>
      <Working kind="making" lead={lead} />
      <p className="muted small">This runs on our side, so you can keep working. It takes a minute or two.</p>
    </>
  );
}
