import { respond } from "../../../../server/http.ts";
import { posterStatus } from "../../../../server/poster.ts";
import { liveDeps } from "../../../../server/deps.ts";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => respond(() => posterStatus(req, liveDeps()));
