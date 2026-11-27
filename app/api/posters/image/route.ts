import { respond } from "../../../../server/http.ts";
import { posterImage } from "../../../../server/poster.ts";
import { liveDeps } from "../../../../server/deps.ts";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => respond(() => posterImage(req, liveDeps()));
