// Netlify background function for posters (see server/poster.ts). Netlify answers the caller 202
// at once and lets this run up to 15 minutes. scripts/bundle-functions.ts bundles it into
// netlify/functions/poster-background.mjs at build time, with the react-server condition.
import { z } from "zod";
import { runPoster } from "../server/poster-run.ts";
import { backgroundDeps } from "../server/bold-start.ts";
import { openaiKey } from "../server/poster-start.ts";

const Trigger = z.strictObject({
  sessionId: z.string().min(1).max(64),
  postId: z.string().min(1).max(64),
  token: z.string().min(1).max(64),
});

export default async (req: Request) => {
  if (req.method !== "POST") return;
  const t = Trigger.safeParse(await req.json().catch(() => null));
  // runPoster checks the token against the stored job before it spends anything.
  if (!t.success) return;
  await runPoster(backgroundDeps(), t.data, openaiKey());
};
