import { respond } from "../../../../server/http.ts";
import { removeReference } from "../../../../server/references.ts";
import { liveDeps } from "../../../../server/deps.ts";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => respond(() => removeReference(req, liveDeps()));
