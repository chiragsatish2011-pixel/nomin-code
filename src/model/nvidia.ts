import type { ModelDescriptor } from "./registry.js";
import type { ChatRequest, Provider, StreamEvent, ToolCall } from "./types.js";

/**
 * NVIDIA provider for Trion 1.5 (Nemotron 3 Ultra 550B A55B).
 *
 * The endpoint is OpenAI-compatible with two wrinkles that matter:
 *  - it streams a separate `reasoning_content` channel (private — the agent
 *    uses it as a "thinking" signal only, never as output), and
 *  - under load it answers 500/503 as readily as 429, so both are treated as
 *    "wait and resume the same work".
 */
export class NvidiaProvider implements Provider {
  readonly id = "nvidia";

  private readonly model: ModelDescriptor;
  private readonly apiKey: string;

  constructor(model: ModelDescriptor, apiKey: string) {
    if (!apiKey) throw new Error(`Missing ${model.apiKeyEnv} — set it in .env`);
    this.model = model;
    this.apiKey = apiKey;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { retry } = this.model;
    let attempt = 0;

    while (true) {
      attempt += 1;
      let response: Response;
      try {
        response = await this.post(request);
      } catch (error) {
        // Network-level failure: same rule as a 503 — back off and resume.
        if (attempt >= retry.maxAttempts) {
          yield { type: "error", message: describe(error) };
          return;
        }
        const wait = backoff(attempt, this.model);
        yield { type: "rate_limit", status: 0, waitSeconds: wait / 1000, attempt };
        await sleep(wait, request.signal);
        yield { type: "cooldown_done", attempt };
        continue;
      }

      if (response.ok && response.body) {
        let streamError = false;
        for await (const event of this.readStream(response.body)) {
          if (event.type === "error" && event.status) {
            streamError = true;
            // Fake the status so the outer retry logic handles it
            Object.defineProperty(response, "status", { value: event.status });
            break;
          }
          yield event;
        }
        if (!streamError) return;
      }

      const retryable = retry.retryStatuses.includes(response.status);
      void (await safeText(response)); // drain the body; its text never surfaces
      if (!retryable || attempt >= retry.maxAttempts) {
        yield {
          type: "error",
          status: response.status,
          message: providerMessage("", response.status),
        };
        return;
      }

      // Honour Retry-After when the provider sends one; otherwise back off.
      const wait = retryAfterMs(response) ?? backoff(attempt, this.model);
      yield {
        type: "rate_limit",
        status: response.status,
        waitSeconds: Math.round(wait / 1000),
        attempt,
      };
      await sleep(wait, request.signal);
      yield { type: "cooldown_done", attempt };
    }
  }

  private post(request: ChatRequest): Promise<Response> {
    const body = {
      model: this.model.backend,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? this.model.maxOutputTokens ?? 4096,
      stream: true,
      ...(request.tools?.length
        ? { tools: request.tools, tool_choice: request.requireTool ? "required" : "auto" }
        : {}),
      // The template exposes its thinking pass as a flag. Turning it off is
      // the difference between a turn that deliberates until the token ceiling
      // and a turn that writes the file.
      ...(request.thinking === false ? { chat_template_kwargs: { thinking: false } } : {}),
    };

    return fetch(`${this.model.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(this.model.timeoutMs),
    });
  }

  /** Parse the SSE body into provider-neutral stream events. */
  private async *readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const pending = new Map<number, ToolCall>();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n");
      while (split !== -1) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        split = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let chunk: NvidiaChunk & { error?: { message: string, type: string, code: number } };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.error) {
          yield { type: "error", status: chunk.error.code || 500, message: chunk.error.message };
          break;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) {
          yield { type: "reasoning", text: delta.reasoning_content };
        }
        if (delta?.content) {
          yield { type: "delta", text: delta.content };
        }
        for (const part of delta?.tool_calls ?? []) {
          const index = part.index ?? 0;
          const call = pending.get(index) ?? {
            id: part.id ?? `call-${index}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name = part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
          pending.set(index, call);
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
        if (choice?.finish_reason) {
          for (const call of pending.values()) yield { type: "tool_call", call };
          pending.clear();
          yield { type: "done", finishReason: choice.finish_reason };
        }
      }
    }

    for (const call of pending.values()) yield { type: "tool_call", call };
  }
}

interface NvidiaChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : null;
}

/** Exponential backoff with jitter, capped by the model's policy. */
function backoff(attempt: number, model: ModelDescriptor): number {
  const { baseDelayMs, maxDelayMs } = model.retry;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}

/**
 * User-facing failure text. It never echoes credentials, endpoints, vendor
 * names or backend model ids — upstream messages often contain all four, so
 * they are mapped to Nomin's own wording rather than passed through.
 */
function providerMessage(_detail: string, status: number): string {
  if (status === 401 || status === 403) return "Trion 1.5 is not authorised right now.";
  if (status === 404) return "Trion 1.5 is unavailable right now.";
  if (status === 413) return "That request is too large for one turn.";
  if (status === 429) return "Trion 1.5 is rate limited. Nomin will resume automatically.";
  if (status >= 500) return "Trion 1.5 is busy. Nomin will retry and resume.";
  return `Trion 1.5 could not complete the turn (${status}).`;
}

/** Network-level failures are reported without the endpoint they came from. */
const describe = (error: unknown) =>
  error instanceof Error && error.name === "TimeoutError"
    ? "Trion 1.5 timed out."
    : "Nomin could not reach Trion 1.5.";
