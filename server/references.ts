// References (core/references.ts): up to five images the owner likes, from their own files or a
// public Cosmos.so board, and three sliders. No model call here; the painter sees the images and the
// kit's references chunk (written by code) says how to use them.
//
//   POST /api/references/image     one image file (multipart: sessionId, file)
//   POST /api/references/cosmos    a board link: the server reads the public page and keeps up to five images
//   POST /api/references/settings  the density, contrast and texture sliders (without them: the saved state)
//   POST /api/references/remove    drops one image
//   POST /api/references/view      one image's bytes, for the thumbnails
//
// Fetching a link is the risky part, so it only ever goes to https cosmos.so pages and cosmos.so
// image hosts, with a timeout, a size cap and no redirects off those hosts, and every download is
// sniffed as an image before it's kept.
import "server-only";
import { z } from "zod";
import { LIMITS } from "../core/limits.ts";
import { DEFAULT_SLIDERS, MAX_REFERENCES, SlidersSchema, cosmosImageLinks, cosmosUrl, isCosmosImageHost, type ReferenceImage, type References } from "../core/references.ts";
import { Refusal, json, readJson } from "./http.ts";
import { loadSession, updateSession, type Session } from "./sessions.ts";
import { parseBody, id, type Deps } from "./handlers.ts";
import { checkImage, sniffImage } from "./uploads.ts";

export const referenceKey = (sessionId: string, refId: string) => `reference/${sessionId}/${refId}`;
const PAGE_BYTES = 3 * 1024 * 1024;

/** What the browser sees. */
export function referencesView(r: References | undefined) {
  return { images: (r?.images ?? []).map(({ id, from }) => ({ id, from })), sliders: r?.sliders ?? DEFAULT_SLIDERS, board: r?.board ?? null };
}

const current = (s: Session): References => s.references ?? { images: [], sliders: DEFAULT_SLIDERS };

async function keep(deps: Deps, sessionId: string, bytes: ArrayBuffer, mediaType: ReferenceImage["mediaType"], from: ReferenceImage["from"], board?: string) {
  const refId = crypto.randomUUID();
  // Claim the slot first, so two tabs can't go over five.
  await updateSession(deps.kv, sessionId, (s) => {
    const r = current(s);
    if (r.images.length >= MAX_REFERENCES) throw new Refusal(429, "references_full", `Up to ${MAX_REFERENCES} references. Remove one to add another.`);
    return { ...s, references: { ...r, images: [...r.images, { id: refId, mediaType, from }], ...(board ? { board } : {}) } };
  });
  await deps.kv.putBytes(referenceKey(sessionId, refId), bytes, { mediaType });
}

export async function addReferenceImage(req: Request, deps: Deps) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new Refusal(415, "multipart_only", "Send one image as multipart/form-data.");
  if (Number(req.headers.get("content-length") ?? "0") > LIMITS.imageBytes + 64 * 1024) throw new Refusal(413, "upload_too_large", `References are capped at ${Math.round(LIMITS.imageBytes / 1024 / 1024)} MB each.`);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new Refusal(400, "bad_form", "The image couldn't be read.");
  }
  const extra = [...new Set(form.keys())].filter((k) => k !== "sessionId" && k !== "file");
  if (extra.length) throw new Refusal(400, "unexpected_fields", `Unexpected field(s): ${extra.join(", ")}.`);
  const file = form.get("file");
  if (!(file instanceof File)) throw new Refusal(400, "bad_fields", `"file" is required.`);
  const { mediaType } = await checkImage(file);
  if (mediaType === "image/gif") throw new Refusal(415, "bad_image", "Use a JPEG, PNG or WebP image as a reference.");
  const sessionId = id.parse(String(form.get("sessionId") ?? ""));
  await loadSession(deps.kv, sessionId, deps.now());
  await keep(deps, sessionId, await file.arrayBuffer(), mediaType, "upload");
  return json({ references: referencesView((await loadSession(deps.kv, sessionId, deps.now())).references) });
}

/** A fetch that stays on cosmos.so: redirects are followed by hand and checked each time. */
async function cosmosFetch(fetchImpl: typeof fetch, url: string, allowed: (u: string) => boolean, accept: string): Promise<Response | null> {
  let at = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!allowed(at)) return null;
    let res: Response;
    try {
      res = await fetchImpl(at, { redirect: "manual", headers: { accept, "user-agent": "Specs (brand kit reader)" }, signal: AbortSignal.timeout(8000) });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return null;
      at = new URL(next, at).href;
      continue;
    }
    return res.ok ? res : null;
  }
  return null;
}

async function capped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? "0") > max) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

const CosmosBody = z.strictObject({ sessionId: id, url: z.string().max(LIMITS.urlChars) });

export async function addCosmosBoard(req: Request, deps: Deps, fetchImpl: typeof fetch = fetch) {
  const body = parseBody(CosmosBody, await readJson(req, LIMITS.jsonBodyBytes));
  const board = cosmosUrl(body.url);
  if (!board) throw new Refusal(400, "not_cosmos", "That isn't a Cosmos link. Paste a public board link from cosmos.so, or drop the images instead.");
  const session = await loadSession(deps.kv, body.sessionId, deps.now());
  const room = MAX_REFERENCES - current(session).images.length;
  if (room <= 0) throw new Refusal(429, "references_full", `Up to ${MAX_REFERENCES} references. Remove one to add another.`);
  const unreadable = new Refusal(422, "cosmos_unreadable", "Specs couldn't read that board (it may be private, or Cosmos changed its pages). Drop 3–5 images from it instead.");
  const page = await cosmosFetch(fetchImpl, board.href, (u) => cosmosUrl(u) !== null, "text/html");
  const html = page ? await capped(page, PAGE_BYTES) : null;
  if (!html) throw unreadable;
  const links = cosmosImageLinks(new TextDecoder().decode(html), room * 2);
  let kept = 0;
  for (const link of links) {
    if (kept >= room) break;
    const res = await cosmosFetch(fetchImpl, link, isCosmosImageHost, "image/*");
    const bytes = res ? await capped(res, LIMITS.imageBytes) : null;
    const mediaType = bytes ? sniffImage(bytes.slice(0, 16)) : null;
    if (!bytes || !mediaType || mediaType === "image/gif") continue;
    await keep(deps, body.sessionId, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mediaType, "cosmos", board.href);
    kept++;
  }
  if (!kept) throw unreadable;
  return json({ references: referencesView((await loadSession(deps.kv, body.sessionId, deps.now())).references), kept });
}

const SettingsBody = z.strictObject({ sessionId: id, sliders: SlidersSchema.optional() });

/** Saves the sliders; with no sliders, just returns what's saved (the step reads it after a reload). */
export async function saveReferenceSettings(req: Request, deps: Deps) {
  const body = parseBody(SettingsBody, await readJson(req, LIMITS.jsonBodyBytes));
  const before = await loadSession(deps.kv, body.sessionId, deps.now());
  if (!body.sliders) return json({ references: referencesView(before.references) });
  const sliders = body.sliders;
  const s = await updateSession(deps.kv, body.sessionId, (s) => ({ ...s, references: { ...current(s), sliders } }));
  return json({ references: referencesView(s.references) });
}

const OneBody = z.strictObject({ sessionId: id, id });

export async function removeReference(req: Request, deps: Deps) {
  const body = parseBody(OneBody, await readJson(req, LIMITS.jsonBodyBytes));
  await loadSession(deps.kv, body.sessionId, deps.now());
  const s = await updateSession(deps.kv, body.sessionId, (s) => {
    const r = current(s);
    const images = r.images.filter((i) => i.id !== body.id);
    return { ...s, references: { ...r, images, ...(images.some((i) => i.from === "cosmos") ? {} : { board: undefined }) } };
  });
  return json({ references: referencesView(s.references) });
}

export async function viewReference(req: Request, deps: Deps) {
  const body = parseBody(OneBody, await readJson(req, LIMITS.jsonBodyBytes));
  const s = await loadSession(deps.kv, body.sessionId, deps.now());
  const img = s.references?.images.find((i) => i.id === body.id);
  const bytes = img ? await deps.kv.getBytes(referenceKey(body.sessionId, img.id)) : null;
  if (!img || !bytes) throw new Refusal(404, "no_reference", "There's no such reference.");
  return new Response(bytes, { status: 200, headers: { "content-type": img.mediaType, "cache-control": "private, max-age=3600" } });
}

/** The session's reference images, for the painter. */
export async function referenceImages(deps: { kv: Deps["kv"] }, s: Session) {
  const out: { mediaType: ReferenceImage["mediaType"]; base64: string }[] = [];
  for (const img of s.references?.images ?? []) {
    const bytes = await deps.kv.getBytes(referenceKey(s.id, img.id));
    if (bytes) out.push({ mediaType: img.mediaType, base64: Buffer.from(bytes).toString("base64") });
  }
  return out;
}
