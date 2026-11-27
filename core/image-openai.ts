// OpenAI's image models as a second painter beside Gemini (Nov 27 poster spike). Same job and
// result shape as core/sketch.ts: text plus reference images in, one image out. With reference
// images it calls the edits endpoint (several images at once); without, the generations endpoint.
// The caller passes the key; nothing here reads, stores or logs it.
import { IMAGE_OPENAI } from "./config.ts";
import type { Image } from "./claude.ts";
import type { SketchResult } from "./sketch.ts";

export const OPENAI_WORST_USD = Math.max(...Object.values(IMAGE_OPENAI.usdPerImage));

export async function paintOpenAI(opts: {
  apiKey: string;
  text: string;
  images: Image[];
  aspect: "1:1" | "4:5";
  model?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Overrides for the speed spike: quality ("low" | "medium" | "high") and size ("1024x1536" for a tall poster or story). */
  quality?: string;
  size?: string;
  /** Streams the painting and calls this with each rough version as it arrives (1–3 of them), seconds since the call began. */
  onPartial?: (p: { index: number; base64: string; seconds: number }) => void;
  partials?: number;
  /** Streamed calls only: each server event's type as it arrives (no image data), for timing and debugging. */
  onEvent?: (type: string, seconds: number) => void;
}): Promise<SketchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  // The closest sizes the models take; code scales the result to the canvas.
  const size = opts.size ?? (opts.aspect === "1:1" ? "1024x1024" : "1024x1536");
  const quality = opts.quality ?? IMAGE_OPENAI.quality;
  const stream = !!opts.onPartial;
  let last = "";
  for (const model of opts.model ? [opts.model] : [...IMAGE_OPENAI.models]) {
    const started = Date.now();
    let res: Response;
    try {
      if (opts.images.length) {
        const form = new FormData();
        form.set("model", model);
        form.set("prompt", opts.text.slice(0, 30000));
        form.set("size", size);
        form.set("quality", quality);
        form.set("n", "1");
        if (stream) {
          form.set("stream", "true");
          form.set("partial_images", String(opts.partials ?? 2));
        }
        opts.images.forEach((img, i) => {
          const ext = img.mediaType.split("/")[1] ?? "png";
          form.append("image[]", new Blob([Buffer.from(img.base64, "base64")], { type: img.mediaType }), `ref-${i + 1}.${ext}`);
        });
        res = await doFetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${opts.apiKey}` }, body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000) });
      } else {
        res = await doFetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: opts.text, size, quality, n: 1, ...(stream ? { stream: true, partial_images: opts.partials ?? 2 } : {}) }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
        });
      }
    } catch (err) {
      return { ok: false, model, error: `${model}: ${err instanceof Error ? err.name : "request failed"}`, billed: true };
    }
    if (stream && res.ok && res.body) {
      // Server-sent events: "...partial_image" events carry rough versions, "...completed" the final one.
      let b64: string | undefined;
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!data || data === "[DONE]") continue;
          const ev = JSON.parse(data) as { type?: string; b64_json?: string; partial_image_index?: number };
          opts.onEvent?.(ev.type ?? "unknown", (Date.now() - started) / 1000);
          if (ev.type?.endsWith("partial_image") && ev.b64_json) opts.onPartial!({ index: ev.partial_image_index ?? 0, base64: ev.b64_json, seconds: (Date.now() - started) / 1000 });
          if (ev.type?.endsWith("completed") && ev.b64_json) b64 = ev.b64_json;
        }
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (!b64) return { ok: false, model, error: `${model} streamed no final image`, billed: true };
      return { ok: true, model, mediaType: "image/png", base64: b64, usd: IMAGE_OPENAI.usdPerImage[model] ?? OPENAI_WORST_USD, seconds };
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string }; data?: { b64_json?: string }[] };
    if (!res.ok) {
      last = `${model}: ${res.status} ${json.error?.message ?? ""}`.trim();
      // An unknown or unavailable model name: try the next one.
      if (res.status === 404 || (res.status === 400 && /model/i.test(json.error?.message ?? "") && !/verif/i.test(json.error?.message ?? ""))) continue;
      return { ok: false, model, error: last, billed: false };
    }
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) return { ok: false, model, error: `${model} returned no image`, billed: true };
    return { ok: true, model, mediaType: "image/png", base64: b64, usd: IMAGE_OPENAI.usdPerImage[model] ?? OPENAI_WORST_USD, seconds };
  }
  return { ok: false, model: null, error: `No OpenAI image model worked. Last answer: ${last}`, billed: false };
}
