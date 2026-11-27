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
}): Promise<SketchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  // The closest sizes the models take; code scales the result to the canvas.
  const size = opts.aspect === "1:1" ? "1024x1024" : "1024x1536";
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
        form.set("quality", IMAGE_OPENAI.quality);
        form.set("n", "1");
        opts.images.forEach((img, i) => {
          const ext = img.mediaType.split("/")[1] ?? "png";
          form.append("image[]", new Blob([Buffer.from(img.base64, "base64")], { type: img.mediaType }), `ref-${i + 1}.${ext}`);
        });
        res = await doFetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${opts.apiKey}` }, body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000) });
      } else {
        res = await doFetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: opts.text, size, quality: IMAGE_OPENAI.quality, n: 1 }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
        });
      }
    } catch (err) {
      return { ok: false, model, error: `${model}: ${err instanceof Error ? err.name : "request failed"}`, billed: true };
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
