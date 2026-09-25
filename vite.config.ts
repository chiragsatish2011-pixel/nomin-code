import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const agentEntry = here("./src/model/index.ts");

/**
 * The agent endpoint.
 *
 * It runs in the dev server, never in the browser, so the API key stays on the
 * machine: the client only ever receives the frames the agent chooses to emit.
 */
function agentApi(env: Record<string, string>): Plugin {
  return {
    name: "nomin-agent-api",
    config() {
      // Every credential the model layer reads, server-side only. Forwarding
      // just one of them is how the monitor silently fell back to evidence
      // mode despite having its own key configured.
      for (const [key, value] of Object.entries(env)) {
        if (!value) continue;
        if (key.startsWith("NVIDIA_") || key.startsWith("NOMIN_")) {
          process.env[key] = value;
        }
      }
    },
    configureServer(server: ViteDevServer) {
      // The monitor runs on its own key, off the hot path: the client calls it
      // after the answer has already landed, with a rendering when it has one.
      // Evidence baseline: capture / diff, used by the manager before it wakes
      // the doctors. Kept on the server because it touches the filesystem.
      // Evidence baseline: capture / diff, used by the manager before it wakes
      // the doctors. Kept on the server because it touches the filesystem.
      // Direct tool exercise — used to test the workspace sandbox.
      server.middlewares.use("/api/tool", async (req: IncomingMessage, res: ServerResponse) => {
        const mod = (await server.ssrLoadModule(agentEntry)) as typeof import("./src/model/index.js");
        const body = await readJson(req);
        res.setHeader("Content-Type", "application/json");
        try {
          const workspace = await mod.Workspace.open(String(body.sessionId ?? "test"));
          const outcome = await mod.runTool(workspace, String(body.name), JSON.stringify(body.args ?? {}));
          res.end(JSON.stringify({ root: workspace.root, ...outcome }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }));
        }
      });

      server.middlewares.use("/api/evidence", async (req: IncomingMessage, res: ServerResponse) => {
        const mod = (await server.ssrLoadModule(agentEntry)) as typeof import("./src/model/index.js");
        const body = req.method === "POST" ? await readJson(req) : {};
        res.setHeader("Content-Type", "application/json");
        try {
          const root = process.cwd();
          if (body.action === "capture") {
            const baseline = await mod.captureBaseline(root, body.force === true);
            res.end(JSON.stringify({ ...baseline, files: baseline.files.length }));
            return;
          }
          const baseline = await mod.loadBaseline(root);
          if (!baseline) {
            res.end(JSON.stringify({ baseline: null, stale: true }));
            return;
          }
          const diff = await mod.diffFromBaseline(root, baseline);
          res.end(
            JSON.stringify({
              takenAt: baseline.takenAt,
              green: baseline.green,
              stale: mod.isStale(baseline),
              fileCount: baseline.fileCount,
              diff,
            }),
          );
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }));
        }
      });

      server.middlewares.use("/api/review", async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }
        const { createSupervisor } = (await server.ssrLoadModule(agentEntry)) as typeof import("./src/model/index.js");
        const body = await readJson(req);
        res.setHeader("Content-Type", "application/json");
        try {
          const verdict = await createSupervisor().review(body.digest ?? body);
          res.end(JSON.stringify(verdict));
        } catch (error) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              status: "unverified",
              summary: "The monitor could not run.",
              issues: [error instanceof Error ? error.message : "unknown"],
              evidence: [],
              usedModel: false,
            }),
          );
        }
      });

      server.middlewares.use("/api/chat", async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }

        const { runTurn } = (await server.ssrLoadModule(agentEntry)) as typeof import("./src/model/index.js");
        const body = await readJson(req);
        // Abort only when the CLIENT goes away. `req`'s own "close" fires as
        // soon as its body has been read, which would kill the stream we are
        // about to start.
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        try {
          for await (const frame of runTurn({
            messages: body.messages ?? [],
            title: body.title,
            model: body.model,
            mode: body.mode,
            sessionId: body.sessionId,
            plan: body.plan ?? null,
            signal: controller.signal,
          })) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) {
            const message = error instanceof Error ? error.message : "Agent failed";
            res.write(`data: ${JSON.stringify({ kind: "error", message })}\n\n`);
            res.write(`data: ${JSON.stringify({ kind: "end" })}\n\n`);
          }
        }
        if (!res.writableEnded) res.end();
      });
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), agentApi(env)],
    resolve: {
      alias: {
        "@nomin/work-tree/react": here("./src/work-tree/react/index.tsx"),
        "@nomin/work-tree": here("./src/work-tree/index.ts"),
        "@nomin/model": agentEntry,
      },
    },
    server: {
      port: 5180,
      open: true,
      // Cross-origin isolation — WebContainer needs it. "credentialless" keeps
      // third-party webfonts loading, which "require-corp" would block.
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    optimizeDeps: { exclude: ["@webcontainer/api"] },
  };
});
