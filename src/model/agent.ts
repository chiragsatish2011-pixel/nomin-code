import { CORE_PROMPT, EMPTY_RETRY_NUDGE, PLAN_PROMPT, WORK_PROMPT, needsWorkPrompt } from "./prompt.js";
import { getModel } from "./registry.js";
import { NvidiaProvider } from "./nvidia.js";
import { planBrief, type Plan } from "./plan.js";
import { createSupervisor, type TurnDigest, type Verdict } from "./supervisor.js";
import { TOOLS, runTool } from "./tools.js";
import { Workspace } from "./workspace.js";
import type { Message, Provider, ToolCall } from "./types.js";

/**
 * One assistant turn.
 *
 * A turn is in one of two modes, and the difference is enforced here rather
 * than requested in a prompt:
 *
 *  - **Planning.** No tools are sent. The model can only think, ask and
 *    propose a plan — it cannot touch the workspace, however it is asked.
 *  - **Execution.** A plan has been approved, so the tools go with the
 *    request and the model reads, writes and runs until the work is done.
 *
 * Everything it does becomes a work-tree event, so the record the manager
 * later judges is made of real operations rather than claims.
 */
export type TurnFrame =
  | { kind: "tree"; event: TreeFrame }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; promptTokens: number; completionTokens: number }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "files"; files: Array<{ path: string; bytes: number; content?: string }> }
  | { kind: "end" };

export interface TreeFrame {
  type: string;
  id?: string;
  parent?: string;
  label?: string;
  detail?: string;
  waitSeconds?: number;
}

/**
 * How much room the model gets. These are real settings, not labels: each one
 * changes the token budget and temperature sent to the provider.
 */
export type Mode = "quick" | "balanced" | "deep";

const MODE_SETTINGS: Record<Mode, { maxTokens: number; temperature: number }> = {
  quick: { maxTokens: 1024, temperature: 0.1 },
  balanced: { maxTokens: 4096, temperature: 0.2 },
  deep: { maxTokens: 8192, temperature: 0.35 },
};

/**
 * On a reasoning model the token budget is the latency dial. Conversation gets
 * a small ceiling and answers almost at once; building takes the full budget.
 */
function resolveBudget(mode: Mode, request: string, executing: boolean) {
  if (mode !== "balanced") return MODE_SETTINGS[mode];
  return executing || needsWorkPrompt(request)
    ? MODE_SETTINGS.deep
    : { maxTokens: 900, temperature: 0.15 };
}

export interface TurnOptions {
  messages: Message[];
  model?: string;
  mode?: Mode;
  signal?: AbortSignal;
  /** Short title for the task node — usually the first line of the request. */
  title?: string;
  /** Which workspace this session owns. Required for tools. */
  sessionId?: string;
  /** The approved plan. Its presence is what unlocks the tools. */
  plan?: Plan | null;
  /**
   * The workspace as the client holds it. On a serverless host every request
   * is a fresh instance with an empty disk, so the files have to travel with
   * the turn — otherwise the agent starts from nothing each time and the
   * canvas never sees what was built.
   */
  files?: Array<{ path: string; content: string }>;
}

/** Files larger than this come back as a listing only. */
const MAX_RETURNED_BYTES = 400_000;

/** How many tool rounds one turn may take before it must report back. */
const MAX_TOOL_ROUNDS = 16;
/** How many times a truncated turn may be continued before giving up. */
const MAX_CONTINUATIONS = 6;

const CONTINUE_NUDGE =
  "You were cut off. Continue from exactly where you stopped — do not repeat anything you already wrote, do not summarise, and do not start over. If a code fence was left open, continue inside it.";

export function createProvider(modelName?: string, env = process.env): Provider {
  const model = getModel(modelName);
  const key = env[model.apiKeyEnv ?? "NVIDIA_API_KEY"] ?? "";
  return new NvidiaProvider(model, key);
}

export async function* runTurn(options: TurnOptions): AsyncGenerator<TurnFrame> {
  const model = getModel(options.model);
  const provider = createProvider(options.model);
  const supervisor = createSupervisor();
  const startedAt = Date.now();

  const request = lastUserMessage(options.messages);
  const executing = Boolean(options.plan && options.sessionId);
  const settings = resolveBudget(options.mode ?? "balanced", request, executing);

  const workspace = executing && options.sessionId ? await Workspace.open(options.sessionId) : null;

  // Restore what the client is holding before the agent looks at anything.
  if (workspace && options.files?.length) {
    for (const file of options.files) {
      await workspace.write(file.path, file.content).catch(() => undefined);
    }
  }
  const log: TreeFrame[] = [];
  const touched = new Map<string, number>();
  const state = {
    answer: "",
    failed: false,
    rateLimited: false,
    thinking: false,
    answering: false,
    finish: "",
    toolCalls: [] as ToolCall[],
  };

  const tree = (event: TreeFrame): TurnFrame => {
    log.push(event);
    return { kind: "tree", event };
  };

  let history = buildPrompt(options.messages, request, executing);
  if (options.plan) history = [...history, { role: "system", content: planBrief(options.plan) }];

  yield tree({ type: "task.started", id: "task", label: options.title ?? "Task" });

  /** One pass at the model. Yields frames; records what happened in `state`. */
  async function* attempt(messages: Message[], pass: number): AsyncGenerator<TurnFrame> {
    state.thinking = true;
    state.toolCalls = [];
    yield tree({ type: "thinking.started", id: `thinking-${pass}`, parent: "task", label: "Thinking" });

    const stream = provider.stream({
      messages,
      tools: executing ? TOOLS : undefined,
      maxTokens: Math.min(settings.maxTokens, model.maxOutputTokens ?? settings.maxTokens),
      temperature: settings.temperature,
      signal: options.signal,
    });

    let cooldowns = 0;

    for await (const event of stream) {
      switch (event.type) {
        case "reasoning":
          break;

        case "delta": {
          if (state.thinking) {
            yield tree({
              type: "thinking.completed",
              id: `thinking-${pass}`,
              label: "Thought through it",
            });
            state.thinking = false;
          }
          if (!state.answering) {
            yield tree({
              type: "step.started",
              id: "answer",
              parent: "task",
              label: executing ? "Working" : "Writing response",
            });
            state.answering = true;
          }
          state.answer += event.text;
          yield { kind: "text", text: event.text };
          break;
        }

        case "tool_call":
          state.toolCalls.push(event.call);
          break;

        case "rate_limit": {
          state.rateLimited = true;
          cooldowns += 1;
          yield tree({
            type: "rate_limit.detected",
            parent: "task",
            label: event.status === 429 ? "Rate limit reached" : "Provider busy",
            detail: event.status ? `HTTP ${event.status}` : "network",
          });
          yield tree({
            type: "cooldown.started",
            id: `cooldown-${pass}-${cooldowns}`,
            parent: "task",
            label: "Waiting for cooldown",
            waitSeconds: event.waitSeconds,
          });
          break;
        }

        case "cooldown_done":
          yield tree({
            type: "cooldown.completed",
            id: `cooldown-${pass}-${cooldowns}`,
            label: "Cooldown complete",
            detail: "state preserved",
          });
          yield tree({ type: "agent.resumed", label: "Resumed" });
          break;

        case "usage":
          yield {
            kind: "usage",
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          };
          break;

        case "error":
          state.failed = true;
          if (state.thinking) {
            yield tree({ type: "thinking.completed", id: `thinking-${pass}`, label: "Stopped" });
            state.thinking = false;
          }
          yield { kind: "error", message: event.message };
          break;

        case "done":
          state.finish = event.finishReason ?? "";
          break;
      }
    }

    if (state.thinking) {
      yield tree({
        type: "thinking.completed",
        id: `thinking-${pass}`,
        label: state.answer || state.toolCalls.length ? "Thought through it" : "No answer produced",
      });
      state.thinking = false;
    }
  }

  // --- the loop ---------------------------------------------------------
  let round = 0;
  let buildOpen = false;

  while (round < MAX_TOOL_ROUNDS) {
    round += 1;
    yield* attempt(history, round);
    if (state.failed || !state.toolCalls.length || !workspace) break;

    if (!buildOpen) {
      yield tree({ type: "step.started", id: "build", parent: "task", label: "Building" });
      buildOpen = true;
    }

    // The model's own turn has to go into the history before its results do.
    history = [
      ...history,
      { role: "assistant", content: state.answer || null, tool_calls: state.toolCalls },
    ];

    for (const call of state.toolCalls) {
      yield tree({
        type: "tool.started",
        id: call.id,
        parent: "build",
        label: describeCall(call),
      });

      const outcome = await runTool(workspace, call.function.name, call.function.arguments);
      yield tree({
        type: outcome.event.type,
        id: call.id,
        parent: "build",
        label: outcome.event.label,
        detail: outcome.event.detail,
      });

      if (outcome.event.type.startsWith("file.")) {
        const path = outcome.output.match(/Wrote ([^\s(]+)/)?.[1];
        if (path) touched.set(path, Date.now());
      }

      history = [
        ...history,
        { role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.output },
      ];
    }

    state.answer = "";
    state.answering = false;
  }

  if (buildOpen) {
    yield tree({
      type: "step.completed",
      id: "build",
      label: touched.size ? `Wrote ${touched.size} file${touched.size === 1 ? "" : "s"}` : "Finished tool work",
    });
  }

  // A reasoning model sometimes spends the whole turn in its private channel,
  // or is cut off mid-file. Neither is a finished turn.
  let continuations = 0;
  while (!executing && needsMore(state) && continuations < MAX_CONTINUATIONS) {
    continuations += 1;
    yield tree({
      type: "step.started",
      id: `continue-${continuations}`,
      parent: "task",
      label: "Continuing",
      detail: `part ${continuations + 1}`,
    });
    state.finish = "";
    yield* attempt(
      [...history, { role: "assistant", content: state.answer }, { role: "user", content: CONTINUE_NUDGE }],
      100 + continuations,
    );
    yield tree({
      type: "step.completed",
      id: `continue-${continuations}`,
      label: `Part ${continuations + 1} written`,
    });
  }

  if (!state.answer && !state.failed && !touched.size) {
    yield tree({ type: "step.started", id: "retry", parent: "task", label: "Empty reply — retrying" });
    yield* attempt([...history, { role: "user", content: EMPTY_RETRY_NUDGE }], 200);
    yield tree({
      type: state.answer ? "step.completed" : "step.failed",
      id: "retry",
      label: state.answer ? "Recovered" : "Still empty",
    });
  }

  if (!state.answer && !state.failed && !touched.size) {
    state.failed = true;
    yield {
      kind: "error",
      message: "Trion 1.5 returned an empty reply twice. Try again, or rephrase the request.",
    };
  }

  if (state.answering && !state.failed) {
    yield tree({ type: "step.completed", id: "answer", label: "Response complete" });
  }

  // Hand the workspace back with contents. The client is the durable copy —
  // it survives the next request landing on a different instance, and a reload.
  if (workspace) {
    const listing = await workspace.list().catch(() => []);
    const files = [];
    for (const file of listing) {
      if (file.bytes > MAX_RETURNED_BYTES) {
        files.push({ path: file.path, bytes: file.bytes });
        continue;
      }
      const content = await workspace.read(file.path).catch(() => undefined);
      files.push({ path: file.path, bytes: file.bytes, content });
    }
    if (files.length) yield { kind: "files", files };
  }

  // --- the manager ------------------------------------------------------
  const digest: TurnDigest = {
    request,
    answer: state.answer,
    events: log.map(({ type, label, detail }) => ({ type, label, detail })),
    durationMs: Date.now() - startedAt,
    rateLimited: state.rateLimited,
    empty: !state.answer && !touched.size,
    files: [...touched.keys()].map((path) => ({ name: path, lines: 0 })),
  };

  yield tree({
    type: "verification.started",
    id: "verify",
    parent: "task",
    label: supervisor.shouldReview(digest) ? "Manager reviewing" : "Checking the record",
  });

  const verdict = await supervisor.review(digest);
  const passed = verdict.status === "verified" || verdict.status === "unverified";
  yield tree({
    type: passed ? "verification.passed" : "verification.failed",
    id: "verify",
    label: verdict.summary,
    detail: verdict.usedModel ? "manager" : "evidence",
  });
  yield { kind: "verdict", verdict };

  yield tree({
    type: state.failed || verdict.status === "failed" ? "step.failed" : "task.completed",
    id: "task",
    label: state.failed ? "Turn failed" : "Turn complete",
  });
  yield { kind: "end" };
}

/**
 * Assemble the request: the frozen core prompt first, so the provider's KV
 * cache can reuse the prefix; the history next; and the mode-specific tier
 * last, where it cannot disturb that cached prefix.
 */
function buildPrompt(messages: Message[], request: string, executing: boolean): Message[] {
  const history =
    messages[0]?.role === "system"
      ? messages
      : [{ role: "system" as const, content: CORE_PROMPT }, ...messages];
  if (executing) return [...history, { role: "system", content: WORK_PROMPT }];
  if (needsWorkPrompt(request)) return [...history, { role: "system", content: PLAN_PROMPT }];
  return history;
}

/** A turn is unfinished if it was cut off, or stopped with a fence still open. */
function needsMore(state: { answer: string; finish: string }): boolean {
  if (!state.answer) return false;
  if (state.finish === "length") return true;
  return (state.answer.match(/```/g)?.length ?? 0) % 2 === 1;
}

function describeCall(call: ToolCall): string {
  const name = call.function.name;
  try {
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    if (name === "write_file") return `Writing ${String(args.path ?? "file")}`;
    if (name === "read_file") return `Reading ${String(args.path ?? "file")}`;
    if (name === "run_command") {
      const list = Array.isArray(args.args) ? args.args.map(String).join(" ") : "";
      return `Running ${String(args.command ?? "")} ${list}`.trim();
    }
    if (name === "list_files") return "Reading the workspace";
  } catch {
    /* fall through to the bare name */
  }
  return name;
}

function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ");
    }
  }
  return "";
}
