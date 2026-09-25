import type { IncomingMessage, ServerResponse } from "node:http";
import { handleFiles } from "../src/server/handlers.js";

/**
 * Vercel function: /api/files
 *
 * The workspace listing and contents, so the canvas renders what the agent
 * actually wrote rather than what it happened to paste into the chat.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleFiles(req, res);
}
