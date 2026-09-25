import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealth } from "../src/server/handlers.js";

/**
 * Vercel function: /api/health
 *
 * Says what this deployment can actually do — which credentials are present
 * (never their values) and which capabilities the host supports. The quickest
 * way to tell a missing environment variable from a broken build.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  handleHealth(req, res);
}
