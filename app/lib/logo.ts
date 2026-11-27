// Browser-only: the visitor's uploaded logo, ready to sign their posts.
import { useEffect, useState } from "react";
import { knockoutPixels } from "../../core/picks.ts";

/**
 * The visitor's logo as a small PNG data URL, so it travels inside each post (and its PNG
 * export) like the photos do. 480 px on the long edge is plenty for a post's signature.
 */
export async function logoDataUrl(sessionId: string, uploadId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/uploads/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, uploadId }) });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

const tokenHex = (css: string, name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? null;

/** The logo redrawn so it reads on the post's background (core/picks.ts knockoutPixels), or as is. */
export async function logoOnBackground(src: string, background: string, text: string | null): Promise<string> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (!knockoutPixels(data.data, background, text)) return src;
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return src;
  }
}

/** The logo as posts should show it on this kit's background: knocked out when it would vanish. Follows color changes. */
export function useLogoFor(raw: string | null, tokensCss: string | undefined): string | null {
  const [shown, setShown] = useState<string | null>(null);
  const bg = tokensCss ? tokenHex(tokensCss, "color-background") : null;
  const text = tokensCss ? tokenHex(tokensCss, "color-text") : null;
  useEffect(() => {
    let live = true;
    if (!raw) return setShown(null);
    if (!bg) return setShown(raw);
    void logoOnBackground(raw, bg, text).then((s) => live && setShown(s));
    return () => {
      live = false;
    };
  }, [raw, bg, text]);
  return shown;
}
