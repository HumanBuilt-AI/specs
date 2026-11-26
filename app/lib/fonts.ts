// Browser-only: font files the owner uploaded, added to a kit's tokens as @font-face rules with the
// file inside as a data URL. Posts render in sandboxed frames (and export to PNG), so the font has
// to travel inside the page like the photos and the logo do.
import { fontFaceCss, type FontExt } from "../../core/fonts.ts";

type WithFonts = { tokensCss: string; fontFiles?: { uploadId: string; family: string; ext: FontExt }[] };

const cache = new Map<string, Promise<string | null>>();

function fontDataUrl(sessionId: string, uploadId: string): Promise<string | null> {
  const key = `${sessionId}:${uploadId}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async () => {
        try {
          const res = await fetch("/api/uploads/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, uploadId }) });
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      })(),
    );
  }
  return cache.get(key)!;
}

/** The kit with its uploaded fonts' @font-face rules at the top of its tokens. */
export async function withFontFiles<K extends WithFonts>(sessionId: string, kit: K): Promise<K> {
  if (!kit.fontFiles?.length) return kit;
  let faces = "";
  for (const f of kit.fontFiles) {
    const url = await fontDataUrl(sessionId, f.uploadId);
    if (url) faces += fontFaceCss(f.family, url, f.ext);
  }
  return faces ? { ...kit, tokensCss: `${faces}${kit.tokensCss}` } : kit;
}
