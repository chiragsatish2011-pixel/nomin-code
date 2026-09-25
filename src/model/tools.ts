import type { Workspace } from "./workspace.js";
import type { ToolDefinition } from "./types.js";

/**
 * The tools Trion may use.
 *
 * Deliberately small. Each one maps to a single workspace operation with an
 * obvious failure mode, because a model recovers from "that path is outside
 * the workspace" far better than from a generic error. There is no delete and
 * no rename: destroying work is a decision for a person, not a side effect of
 * a turn.
 *
 * Every result comes back as text the model can read, and every result is also
 * an event in the work tree — so what the agent did is visible, not inferred.
 */

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the files in the workspace. Call this first when continuing work, so you build on what is already there.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory to list. Defaults to the workspace root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read one file from the workspace. Always read a file before editing it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path inside the workspace, e.g. src/app.ts" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with its complete contents. Never write a partial file or a placeholder.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path inside the workspace, e.g. index.html" },
          content: { type: "string", description: "The entire file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a command in the workspace to install, build or test. Allowed: npm, npx, node, tsc, vite.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The executable, e.g. npm" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Arguments as separate strings, e.g. [\"install\"]",
          },
        },
        required: ["command"],
      },
    },
  },
];

export interface ToolOutcome {
  /** Text handed back to the model. */
  output: string;
  /** What the work tree should show. */
  event: {
    type: string;
    label: string;
    detail?: string;
    failed?: boolean;
  };
}

/** Execute one tool call against a workspace. Never throws. */
export async function runTool(
  workspace: Workspace,
  name: string,
  rawArguments: string,
): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
  } catch {
    return fail(name, "Arguments were not valid JSON.");
  }

  try {
    switch (name) {
      case "list_files": {
        const files = await workspace.list(typeof args.dir === "string" ? args.dir : ".");
        const listing = files.length
          ? files.map((file) => `${file.path} (${file.bytes} bytes)`).join("\n")
          : "The workspace is empty.";
        return {
          output: listing,
          event: { type: "tool.completed", label: "Read the workspace", detail: `${files.length} files` },
        };
      }

      case "read_file": {
        const path = String(args.path ?? "");
        const content = await workspace.read(path);
        return {
          output: content,
          event: {
            type: "tool.completed",
            label: `Read ${path}`,
            detail: `${content.split("\n").length} lines`,
          },
        };
      }

      case "write_file": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        const existed = await workspace.exists(path);
        const file = await workspace.write(path, content);
        return {
          output: `Wrote ${file.path} (${file.bytes} bytes).`,
          event: {
            type: existed ? "file.modified" : "file.created",
            label: existed ? `Edited ${file.path}` : `Created ${file.path}`,
            detail: `${content.split("\n").length} lines`,
          },
        };
      }

      case "run_command": {
        const command = String(args.command ?? "");
        const list = Array.isArray(args.args) ? args.args.map(String) : [];
        const result = await workspace.run(command, list);
        const ok = result.exitCode === 0;
        const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return {
          output: `${result.command} exited ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${body || "(no output)"}`,
          event: {
            type: ok ? "command.completed" : "command.failed",
            label: ok ? `Ran ${result.command}` : `${result.command} failed`,
            detail: result.timedOut ? "timed out" : `exit ${result.exitCode}`,
            failed: !ok,
          },
        };
      }

      default:
        return fail(name, `There is no tool called "${name}".`);
    }
  } catch (error) {
    return fail(name, error instanceof Error ? error.message : "The tool failed.");
  }
}

function fail(name: string, message: string): ToolOutcome {
  return {
    output: `Error: ${message}`,
    event: { type: "tool.failed", label: `${name} failed`, detail: message.slice(0, 80), failed: true },
  };
}
