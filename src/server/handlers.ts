import type { IncomingMessage, ServerResponse } from "node:http";
import { runTurn } from "../model/agent.js";
import { captureBaseline, diffFromBaseline, isStale, loadBaseline } from "../model/evidence.js";
import { createSupervisor } from "../model/supervisor.js";
import { describeMedia, visionContext } from "../model/vision.js";
import { Workspace } from "../model/workspace.js";

/**
 * The agent API, written once.
 *
 * The dev server mounts these as middleware; Vercel mounts them as functions.
 * Keeping one implementation is the point: an endpoint that only exists in
 * `vite.config.ts` works perfectly on a laptop and is simply absent in
 * production, which is exactly the failure this module removes.
 *
 * Everything here runs server-side, so credentials stay on the server in both
 * environments and the browser only ever receives frames.
 */

/** True on a platform with a read-only filesystem and no long-lived process. */
export const isServerless = (): boolean =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  // Some platforms parse the body for us; others hand over the raw stream.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
  if (typeof parsed === "string") {
    try {
      return JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** POST /api/chat — streams one agent turn as server-sent events. */
export async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJson(req);
  const controller = new AbortController();
  // Abort only when the client goes away: `req`'s own close fires as soon as
  // its body has been read, which would kill the stream before it starts.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this a proxy will buffer the whole turn and deliver it at the end.
    "X-Accel-Buffering": "no",
  });

  try {
    for await (const frame of runTurn({
      messages: body.messages ?? [],
      title: body.title,
      model: body.model,
      mode: body.mode,
      sessionId: body.sessionId,
      plan: body.plan ?? null,
      files: Array.isArray(body.files) ? body.files : undefined,
      signal: controller.signal,
    })) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The turn failed.";
    res.write(`data: ${JSON.stringify({ kind: "error", message })}\n\n`);
    res.write(`data: ${JSON.stringify({ kind: "end" })}\n\n`);
  }
  res.end();
}

/** POST /api/review — the manager's verdict on a finished turn. */
export async function handleReview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const body = await readJson(req);
  try {
    const verdict = await createSupervisor().review(body.digest ?? body);
    json(res, 200, verdict);
  } catch (error) {
    json(res, 500, {
      status: "unverified",
      summary: "The manager could not run.",
      issues: [error instanceof Error ? error.message : "unknown"],
      evidence: [],
      usedModel: false,
    });
  }
}

/** POST /api/vision — frames in, words out. */
export async function handleVision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const body = await readJson(req);
  try {
    const results = [];
    for (const item of body.media ?? []) {
      results.push(
        await describeMedia({
          name: String(item.name ?? "attachment"),
          kind: item.kind === "video" ? "video" : "image",
          frames: Array.isArray(item.frames) ? item.frames : [],
          duration: typeof item.duration === "number" ? item.duration : undefined,
          question: typeof body.question === "string" ? body.question : undefined,
        }),
      );
    }
    json(res, 200, { results, context: visionContext(results) });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Vision failed" });
  }
}

/**
 * POST /api/evidence — the baseline the manager measures against.
 *
 * It reads the project's own source and runs its typecheck, neither of which
 * exists on a serverless host, so it reports that plainly instead of returning
 * a baseline it could not take.
 */
export async function handleEvidence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isServerless()) {
    json(res, 200, {
      baseline: null,
      stale: true,
      unavailable: "The evidence baseline reads the project source, which a serverless host does not have.",
    });
    return;
  }

  const body = await readJson(req);
  try {
    const root = process.cwd();
    if (body.action === "capture") {
      const baseline = await captureBaseline(root, body.force === true);
      json(res, 200, { ...baseline, files: baseline.files.length });
      return;
    }
    const baseline = await loadBaseline(root);
    if (!baseline) {
      json(res, 200, { baseline: null, stale: true });
      return;
    }
    const diff = await diffFromBaseline(root, baseline);
    json(res, 200, {
      takenAt: baseline.takenAt,
      green: baseline.green,
      stale: isStale(baseline),
      fileCount: baseline.fileCount,
      diff,
    });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "failed" });
  }
}

/**
 * POST /api/files — the workspace as the canvas sees it.
 *
 * The canvas used to read code out of the chat, which stopped working the
 * moment the agent started writing real files instead of pasting them. This
 * returns what is actually on disk: the listing, and the contents of the text
 * files small enough to render.
 */
export async function handleFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? "");
  if (!sessionId) {
    json(res, 400, { error: "A sessionId is required." });
    return;
  }

  try {
    const workspace = await Workspace.open(sessionId);
    const listing = await workspace.list();
    const wanted = listing.filter((file) => READABLE.test(file.path) && file.bytes <= MAX_READ_BYTES);

    const files = await Promise.all(
      wanted.map(async (file) => ({
        path: file.path,
        bytes: file.bytes,
        modified: file.modified,
        content: await workspace.read(file.path).catch(() => ""),
      })),
    );

    json(res, 200, {
      files,
      // Files too large or too binary to render still belong in the listing.
      others: listing
        .filter((file) => !wanted.includes(file))
        .map((file) => ({ path: file.path, bytes: file.bytes, modified: file.modified })),
    });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Could not read the workspace." });
  }
}

const READABLE = /\.(html?|css|m?js|jsx|tsx?|json|md|txt|svg|ya?ml)$/i;
const MAX_READ_BYTES = 400_000;

/** GET /api/health — what this deployment can actually do. */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const serverless = isServerless();
  json(res, 200, {
    ok: true,
    // Never the key itself, and never the backend's name — only whether the
    // deployment is configured at all.
    worker: Boolean(process.env.NVIDIA_API_KEY),
    manager: Boolean(process.env.NOMIN_SUPERVISOR_API_KEY),
    vision: Boolean(process.env.NOMIN_VISION_API_KEY || process.env.NOMIN_SUPERVISOR_API_KEY),
    doctors: [1, 2, 3, 4, 5, 6].filter((n) => process.env[`NOMIN_DOCTOR_${n}_API_KEY`]).length,
    environment: serverless ? "serverless" : "server",
    capabilities: {
      tools: true,
      commands: !serverless,
      evidence: !serverless,
      persistentWorkspace: !serverless,
    },
  });
}
