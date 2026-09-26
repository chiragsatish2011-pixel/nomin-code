/** The common model interface. Nothing above this layer knows about NVIDIA. */

export type Role = "system" | "user" | "assistant" | "tool";

/** A multimodal message part — text, or an image the monitor should look at. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  /** Present on assistant turns that called tools. */
  tool_calls?: ToolCall[];
  /** Present on tool results. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Ask the chat template to skip its private reasoning pass. A reasoning
   * model given tools and a finished plan will otherwise spend the whole
   * budget deliberating and never emit a call.
   */
  thinking?: boolean;
  /** Insist on a tool call rather than leaving it to the model's judgement. */
  requireTool?: boolean;
}

/**
 * What a provider streams back.
 *
 * `reasoning` carries the model's private scratchpad. It never reaches the UI
 * verbatim — the agent uses it only to know that the model is *thinking*, and
 * surfaces a short status instead.
 */
export type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string; status?: number }
  | { type: "rate_limit"; status: number; waitSeconds: number; attempt: number }
  | { type: "cooldown_done"; attempt: number };

export interface Provider {
  readonly id: string;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
}
