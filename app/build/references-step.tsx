"use client";

// Step 4 of the upload screen (build plan "Specs: new kit flow"): what the owner wants their pieces
// to feel like. A public Cosmos.so board link, or 3–5 images dropped in, plus three sliders. The
// images go to the painter as reference posters; the sliders go into the kit's references chunk.
import { useEffect, useState } from "react";
import { DEFAULT_SLIDERS, MAX_REFERENCES, REFERENCE_SLIDERS, SLIDER_LABELS, type Sliders } from "../../core/references.ts";
import { call, sendForm, type ApiError } from "../lib/api.ts";
import { prepareImage } from "../lib/images.ts";

type View = { images: { id: string; from: "upload" | "cosmos" }[]; sliders: Sliders; board: string | null };
const OK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const message = (e: unknown) => (e as ApiError)?.message ?? "Something went wrong. Try again.";

/** One reference's bytes as an object URL (the view route is a POST, so an <img src> can't fetch it). */
function Thumb({ sessionId, id }: { sessionId: string; id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    fetch("/api/references/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, id }) })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b || !live) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionId, id]);
  return src ? <img src={src} alt="" /> : <div className="ref-thumb-wait" aria-hidden />;
}

export function ReferencesStep(props: { sessionId: string; onBack: () => void; onDone: () => void }) {
  const { sessionId } = props;
  const [view, setView] = useState<View>({ images: [], sliders: DEFAULT_SLIDERS, board: null });
  const [sliders, setSliders] = useState<Sliders>(DEFAULT_SLIDERS);
  const [board, setBoard] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const full = view.images.length >= MAX_REFERENCES;

  // After a reload, show what's already saved.
  useEffect(() => {
    call<{ references: View }>("/api/references/settings", { sessionId })
      .then(({ references }) => {
        setView(references);
        setSliders(references.sliders);
        if (references.board) setBoard(references.board);
      })
      .catch(() => {});
  }, [sessionId]);

  async function readBoard() {
    if (!board.trim()) return;
    setError(null);
    setBusy("Reading your board…");
    try {
      const r = await call<{ references: View; kept: number }>("/api/references/cosmos", { sessionId, url: board.trim() }, { timeoutMs: 45_000 });
      setView(r.references);
    } catch (e) {
      setError(message(e));
    }
    setBusy(null);
  }

  async function addImages(files: File[]) {
    setError(null);
    const room = MAX_REFERENCES - view.images.length;
    const usable = files.filter((f) => f.type.startsWith("image/"));
    if (usable.length < files.length) setError("Only images work as references.");
    if (!usable.length || room <= 0) return;
    setBusy("Adding your references…");
    for (const f of usable.slice(0, room)) {
      try {
        const { file } = await prepareImage(f, "image");
        if (!OK_TYPES.has(file.type)) throw { message: `${f.name}: use a JPEG, PNG or WebP image.` };
        const r = await sendForm<{ references: View }>("/api/references/image", { sessionId, file });
        setView(r.references);
      } catch (e) {
        setError(message(e));
      }
    }
    if (usable.length > room) setError(`Up to ${MAX_REFERENCES} references; the rest were left out.`);
    setBusy(null);
  }

  async function remove(id: string) {
    setError(null);
    try {
      setView((await call<{ references: View }>("/api/references/remove", { sessionId, id })).references);
    } catch (e) {
      setError(message(e));
    }
  }

  async function next(skip: boolean) {
    setError(null);
    if (!skip) {
      setBusy("Saving…");
      try {
        await call("/api/references/settings", { sessionId, sliders });
      } catch (e) {
        setBusy(null);
        return setError(message(e));
      }
      setBusy(null);
    }
    props.onDone();
  }

  return (
    <div className="card setup-step">
      <h2 className="step-title">
        References. <span>What should your pieces feel like?</span>
      </h2>
      <p className="muted">Paste a public Cosmos.so board, or drop 3–5 posters or ads you love. Specs borrows their texture, print and type treatment in your colors, never their words or logos.</p>

      <label htmlFor="cosmos">Cosmos board link</label>
      <div className="ref-board">
        <input id="cosmos" type="url" placeholder="https://www.cosmos.so/…" value={board} onChange={(e) => setBoard(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), readBoard())} disabled={full || !!busy} />
        <button type="button" className="c-btn ghost" onClick={readBoard} disabled={full || !!busy || !board.trim()}>
          Read board
        </button>
      </div>

      <div
        className={`dropzone ${dragging ? "over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addImages([...e.dataTransfer.files]);
        }}
      >
        <p className="dropzone-title">Or drop reference images here</p>
        <p className="muted small">
          JPEG, PNG or WebP, up to {MAX_REFERENCES}. {view.images.length} of {MAX_REFERENCES} added.
        </p>
        <div className="dropzone-pick">
          <label htmlFor="refs" className="c-btn ghost">
            Choose images
          </label>
          <input id="refs" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif" multiple disabled={full || !!busy} onChange={(e) => (addImages([...(e.target.files ?? [])]), (e.target.value = ""))} />
        </div>
      </div>

      {view.images.length > 0 && (
        <div className="photo-grid ref-grid">
          {view.images.map((img, i) => (
            <figure key={img.id} className="photo-tile">
              <Thumb sessionId={sessionId} id={img.id} />
              <figcaption>
                <span className="small">{img.from === "cosmos" ? `From your board ${i + 1}` : `Reference ${i + 1}`}</span>
                <button type="button" className="quiet" onClick={() => remove(img.id)} aria-label={`Remove reference ${i + 1}`}>
                  Remove
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="ref-sliders">
        {REFERENCE_SLIDERS.map((k) => {
          const l = SLIDER_LABELS[k];
          return (
            <div key={k} className="ref-slider">
              <label htmlFor={`slider-${k}`}>{l.name}</label>
              <div className="ref-slider-row">
                <span className="muted small">{l.low}</span>
                <input id={`slider-${k}`} type="range" min={1} max={5} step={1} value={sliders[k]} onChange={(e) => setSliders((s) => ({ ...s, [k]: Number(e.target.value) }))} aria-valuetext={`${sliders[k]} of 5`} />
                <span className="muted small">{l.high}</span>
              </div>
            </div>
          );
        })}
      </div>

      {busy && <p className="muted small" role="status">{busy}</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}

      <div className="step-actions">
        <button onClick={() => next(false)} disabled={!!busy}>
          Next: words
        </button>
        <button className="c-btn ghost" onClick={() => next(true)} disabled={!!busy}>
          Skip references
        </button>
        <button className="c-btn ghost" onClick={props.onBack} disabled={!!busy}>
          Back to fonts
        </button>
      </div>
    </div>
  );
}
