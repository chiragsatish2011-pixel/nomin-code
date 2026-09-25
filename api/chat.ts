import type { IncomingMessage, ServerResponse } from "node:http";
import { handleChat } from "../src/server/handlers.js";

/**
 * Vercel function: /api/chat
 *
 * The implementation lives in `src/server/handlers.ts` so the dev server and
 * production run exactly the same code. This file only adapts the platform's
 * request to it.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleChat(req, res);
}
