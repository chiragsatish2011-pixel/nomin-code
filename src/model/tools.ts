import { parseLooseJson } from "./tooltext.js";
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
      name: "append_file",
      description:
        "Add text to the end of an existing file. Use this to finish a file that was cut off, or to write a long file in several parts, rather than re-sending the whole thing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path inside the workspace, e.g. index.html" },
          content: { type: "string", description: "Text to add at the end, continuing exactly where the file stops." },
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
    /** The evidence the user can open: the file, the output, what was read. */
    body?: string;
    bodyKind?: "thinking" | "code" | "output" | "text";
    bodyTitle?: string;
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
    args = rawArguments ? ((parseLooseJson(rawArguments) ?? {}) as Record<string, unknown>) : {};
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
          event: {
            type: "tool.completed",
            label: "Read the workspace",
            detail: `${files.length} files`,
            body: listing,
            bodyKind: "output",
            bodyTitle: "Workspace listing",
          },
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
            body: content,
            bodyKind: "code",
            bodyTitle: path,
          },
        };
      }

      case "write_file": {
        const path = String(args.path ?? "");
        const content = cleanContent(String(args.content ?? ""));
        const existed = await workspace.exists(path);
        const file = await workspace.write(path, content);
        return {
          output: `Wrote ${file.path} (${file.bytes} bytes).`,
          event: {
            type: existed ? "file.modified" : "file.created",
            label: existed ? `Edited ${file.path}` : `Created ${file.path}`,
            detail: `${content.split("\n").length} lines`,
            // The whole file, so "what did it write" is one click away rather
            // than a guess from a line count.
            body: content,
            bodyKind: "code",
            bodyTitle: file.path,
          },
        };
      }

      case "append_file": {
        const path = String(args.path ?? "");
        const content = cleanContent(String(args.content ?? ""));
        const file = await workspace.append(path, content);
        return {
          output: `Appended to ${file.path}; it is now ${file.bytes} bytes.`,
          event: {
            type: "file.modified",
            label: `Continued ${file.path}`,
            detail: `+${content.split("\n").length} lines`,
            body: content,
            bodyKind: "code",
            bodyTitle: `${file.path} (added)`,
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
            body: `$ ${result.command}\n\n${body || "(no output)"}`,
            bodyKind: "output",
            bodyTitle: result.command,
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

/**
 * Keep the model's narration out of the file.
 *
 * Asked to continue a file that was cut off, the model sometimes answers the
 * way it would answer a person — "The user wants me to continue the HTML from
 * where it was cut off" — and that sentence lands in the file, because it was
 * passed as the content argument. It is only ever a leading line or two, and
 * only ever before the real content starts, so it can be removed without
 * touching anything the file legitimately contains.
 */
function cleanContent(content: string): string {
  const narration =
    /^(?:(?:the user|they)\s+(?:wants?|asked|is asking)|let me|i'?ll |i will |i'?m going to|continuing (?:from|the)|here(?:'s| is) (?:the|my)|picking up|resuming)\b[^\n]*\n/i;

  let out = content;
  // At most two, so a file that genuinely opens with prose keeps it.
  for (let pass = 0; pass < 2; pass++) {
    const trimmed = out.replace(/^[\n\s]+/, "");
    if (!narration.test(trimmed)) break;
    out = trimmed.replace(narration, "");
  }
  return out === content ? content : out.replace(/^[\n\s]+/, "");
}

/** The names the turn offers, for recognising a call written as prose. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.function.name);
