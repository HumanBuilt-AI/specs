import { respond } from "../../../../server/http.ts";
import { startPoster } from "../../../../server/poster.ts";
import { liveDeps } from "../../../../server/deps.ts";
import { posterStarter, openaiKey } from "../../../../server/poster-start.ts";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => respond(() => startPoster(req, liveDeps(), posterStarter(req), Boolean(openaiKey())));
