import { respond } from "../../../../server/http.ts";
import { addCosmosBoard } from "../../../../server/references.ts";
import { liveDeps } from "../../../../server/deps.ts";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => respond(() => addCosmosBoard(req, liveDeps()));
