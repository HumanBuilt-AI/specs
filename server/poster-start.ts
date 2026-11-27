// How a poster's background work gets started. On Netlify: a request to the background function
// (it answers 202 at once and runs up to 15 minutes). Elsewhere (next dev with the memory store):
// the same work, in this process, not awaited.
import "server-only";
import { runPoster } from "./poster-run.ts";
import { backgroundDeps } from "./bold-start.ts";
import type { PosterTrigger, StartPosterBackground } from "./poster.ts";

export const openaiKey = () => process.env.OPENAI_API_KEY?.trim() || undefined;

export function posterStarter(req: Request): StartPosterBackground {
  const onNetlify = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (!onNetlify) {
    return async (t: PosterTrigger) => {
      void runPoster(backgroundDeps(), t, openaiKey());
    };
  }
  return async (t: PosterTrigger) => {
    const base = process.env.URL && process.env.CONTEXT === "production" ? process.env.URL : new URL(req.url).origin;
    const res = await fetch(`${base}/.netlify/functions/poster-background`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t), signal: AbortSignal.timeout(8000) });
    if (res.status !== 202 && !res.ok) throw new Error(`Background function answered ${res.status}`);
  };
}
