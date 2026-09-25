import type { IncomingMessage, ServerResponse } from "node:http";
import { handleEvidence } from "../src/server/handlers.js";

/**
 * Vercel function: /api/evidence
 *
 * The implementation lives in `src/server/handlers.ts` so the dev server and
 * production run exactly the same code. This file only adapts the platform's
 * request to it.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleEvidence(req, res);
}
