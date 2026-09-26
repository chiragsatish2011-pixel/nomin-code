/**
 * The model registry.
 *
 * Nomin Code's model names are product names; the backend behind each one is
 * a detail recorded here. Only Trion 1.5 is integrated — Nect 1.3 and Fret 5
 * are declared so the surrounding system can already reason about them, and
 * they fail loudly rather than pretending to work.
 */

export type ModelStatus = "available" | "planned";

/**
 * A model is registered for a role, not just by name. Today the worker role is
 * Trion 1.5 and the supervisor role is a separate, optional model with its own
 * credentials — so a future Nect 1.3 or Fret 5 can take either seat without
 * touching the agent.
 */
export type ModelRole = "worker" | "supervisor";

export interface RetryPolicy {
  maxAttempts: number;
  /** First backoff step in ms; doubles each attempt. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** HTTP statuses that mean "wait and try the same work again". */
  retryStatuses: number[];
}

export interface ModelDescriptor {
  /** Product name, exactly as users see it. */
  name: string;
  role: ModelRole;
  status: ModelStatus;
  /** Backend model identifier at the provider. */
  backend?: string;
  provider?: "nvidia";
  endpoint?: string;
  /** Environment variable holding the key. The key itself never lives here. */
  apiKeyEnv?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  capabilities: {
    tools: boolean;
    streaming: boolean;
    /** Emits a private reasoning channel that must not be shown verbatim. */
    reasoning: boolean;
    vision: boolean;
  };
  retry: RetryPolicy;
  timeoutMs: number;
  notes?: string;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  // 429 = rate limited. 500/502/503/504 = the provider is overloaded; the NVIDIA
  // endpoint returns these under load and they clear on their own.
  retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
};


/**
 * Where the backend identifiers come from.
 *
 * The product names in this file are Nomin's own and are meant to be read.
 * What sits behind them is not: naming the vendor and the base model in a
 * public repository tells anybody exactly what Trion is, which is the one
 * thing the interface is careful never to leak. They move to the environment,
 * and the fallbacks here are deliberately generic so a missing variable
 * produces a clear failure rather than a quiet disclosure.
 */
export function backendOf(key: string, fallback = ""): string {
  const fromEnv =
    typeof process !== "undefined" ? (process.env?.[key] ?? "") : "";
  return fromEnv || fallback;
}

export function endpointOf(fallback = ""): string {
  return backendOf("NOMIN_BASE_URL", fallback);
}

export const TRION_1_5: ModelDescriptor = {
  name: "Trion 1.5",
  role: "worker",
  status: "available",
  backend: backendOf("NOMIN_WORKER_MODEL"),
  provider: "nvidia",
  endpoint: endpointOf(),
  apiKeyEnv: "NVIDIA_API_KEY",
  contextTokens: 128_000,
  maxOutputTokens: 8192,
  capabilities: { tools: false, streaming: true, reasoning: true, vision: false },
  retry: DEFAULT_RETRY,
  timeoutMs: 180_000,
  notes:
    "Nemotron 3 Ultra streams a separate reasoning channel and rejects inline " +
    "thinking directives such as /no_think in the system prompt.",
};

export const NECT_1_3: ModelDescriptor = {
  name: "Nect 1.3",
  role: "worker",
  status: "planned",
  capabilities: { tools: true, streaming: true, reasoning: false, vision: false },
  retry: DEFAULT_RETRY,
  timeoutMs: 120_000,
  notes: "Future integration. No backend assigned.",
};

export const FRET_5: ModelDescriptor = {
  name: "Fret 5",
  role: "worker",
  status: "planned",
  capabilities: { tools: true, streaming: true, reasoning: false, vision: false },
  retry: DEFAULT_RETRY,
  timeoutMs: 120_000,
  notes: "Future integration. No backend assigned.",
};

/**
 * The supervisor seat. It is intentionally a smaller, cheaper model on its own
 * credentials: reviewing a digest is far less work than producing one, and
 * keeping it on a separate key means review traffic never eats the worker's
 * rate limit. Leave `NOMIN_SUPERVISOR_API_KEY` unset and Nomin Code reviews on
 * local evidence alone — no second model, no extra cost.
 */
export const SUPERVISOR: ModelDescriptor = {
  name: "Nomin Monitor",
  role: "supervisor",
  status: "available",
  backend: backendOf("NOMIN_VISION_MODEL"),
  provider: "nvidia",
  endpoint: endpointOf(),
  apiKeyEnv: "NOMIN_SUPERVISOR_API_KEY",
  contextTokens: 128_000,
  maxOutputTokens: 900,
  capabilities: { tools: false, streaming: true, reasoning: true, vision: true },
  retry: { ...DEFAULT_RETRY, maxAttempts: 4, baseDelayMs: 1500 },
  timeoutMs: 90_000,
  notes:
    "Multimodal reviewer: reads a compact turn digest and, when the work is " +
    "previewable, looks at a rendering of it. Never writes code or runs tools.",
};

export const MODELS: Record<string, ModelDescriptor> = {
  "Trion 1.5": TRION_1_5,
  "Nect 1.3": NECT_1_3,
  "Fret 5": FRET_5,
};

/** The model the agent runs on today. */
export const DEFAULT_MODEL = "Trion 1.5";

export function getModel(name: string = DEFAULT_MODEL): ModelDescriptor {
  const model = MODELS[name];
  if (!model) throw new Error(`Unknown model: ${name}`);
  if (model.status === "planned") {
    throw new Error(`${model.name} is not integrated yet — use ${DEFAULT_MODEL}.`);
  }
  return model;
}

export const listModels = () => Object.values(MODELS);

/** All registered models for a role, including the ones not yet integrated. */
export const modelsForRole = (role: ModelRole) =>
  [...Object.values(MODELS), SUPERVISOR].filter((model) => model.role === role);
