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
  /**
   * The environment variable that overrides this seat's backend model, for a
   * deployment that wants to move a seat without a code change.
   */
  backendEnv?: string;
  /**
   * The backend model identifier. The variable above wins when it is set; this
   * is what the seat runs on otherwise, so a deployment holding nothing but a
   * credential still works.
   */
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
 * Each seat carries the model it runs on and the variable that overrides it.
 * The variable wins where it is set; the identifier in the descriptor is what
 * runs otherwise, so a deployment that holds only a credential works — which
 * is the common case, and was worth more here than keeping the identifiers out
 * of the source. Overriding one is a deployment setting, not a code change.
 */
export function backendOf(key: string, fallback = "", env = readEnv()): string {
  return (env[key] ?? "").trim() || fallback;
}

/**
 * The provider's base URL. Unlike a model identifier this is an address, not a
 * disclosure — it says nothing about which model answers on it — so it has a
 * real default. It had none, and every seat resolved to an empty endpoint
 * wherever `NOMIN_BASE_URL` was unset, which is every deployment configured
 * before that variable existed: the request then went to a relative path and
 * failed in a way that pointed nowhere near the cause. `NVIDIA_BASE_URL` is
 * still honoured because it is what the older deployments and the README set.
 */
export function endpointOf(fallback = DEFAULT_ENDPOINT, env = readEnv()): string {
  return backendOf("NOMIN_BASE_URL", "", env) || backendOf("NVIDIA_BASE_URL", fallback, env);
}

const DEFAULT_ENDPOINT = "https://integrate.api.nvidia.com/v1";

/** The environment, or an empty one in a bundle that has no `process`. */
function readEnv(): NodeJS.ProcessEnv {
  return typeof process !== "undefined" && process.env ? process.env : ({} as NodeJS.ProcessEnv);
}

export const TRION_1_5: ModelDescriptor = {
  name: "Trion 1.5",
  role: "worker",
  status: "available",
  backendEnv: "NOMIN_WORKER_MODEL",
  backend: "nvidia/nemotron-3-ultra-550b-a55b",
  provider: "nvidia",
  apiKeyEnv: "NVIDIA_API_KEY",
  contextTokens: 128_000,
  maxOutputTokens: 8192,
  capabilities: { tools: false, streaming: true, reasoning: true, vision: false },
  retry: DEFAULT_RETRY,
  timeoutMs: 180_000,
  notes:
    "The worker streams a separate reasoning channel and rejects inline " +
    "thinking directives such as /no_think in the system prompt; the thinking " +
    "pass is switched off through the chat template instead.",
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
  backendEnv: "NOMIN_SUPERVISOR_MODEL",
  backend: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  provider: "nvidia",
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

/**
 * Fill in a descriptor's backend and endpoint from the environment.
 *
 * Read when the seat is used, not when this module is imported. Capturing the
 * values at import time meant a host that populates the environment around the
 * module — a serverless function on a cold start, the dev server's own config
 * step, a test passing its own environment in — got whatever happened to be set
 * at that instant, and nothing later could correct it.
 *
 * `extra` names variables to fall back to, for a seat that shares its model
 * with another: the monitor and the vision pass are the same model on the same
 * key, so either variable configures both.
 */
export function resolveBackend(
  model: ModelDescriptor,
  env: NodeJS.ProcessEnv = readEnv(),
  extra: string[] = [],
): ModelDescriptor {
  const names = [model.backendEnv, ...extra].filter(Boolean) as string[];
  const backend = names.map((name) => (env[name] ?? "").trim()).find(Boolean) ?? model.backend ?? "";
  if (!backend) {
    throw new Error(
      `${model.name} has no backend model configured. Set ${names[0] ?? "its model variable"} ` +
        `in this deployment's environment variables.`,
    );
  }
  return { ...model, backend, endpoint: model.endpoint ?? endpointOf(undefined, env) };
}

/**
 * Whether a seat could actually run: a credential *and* a model identifier.
 * Both halves, because a health check that reports one is how a deployment
 * looks ready and then fails its first turn.
 */
export function modelConfigured(
  model: ModelDescriptor,
  env: NodeJS.ProcessEnv = readEnv(),
  extra: string[] = [],
): boolean {
  const hasKey = Boolean(model.apiKeyEnv && env[model.apiKeyEnv]);
  const names = [model.backendEnv, ...extra].filter(Boolean) as string[];
  const hasBackend = names.some((name) => env[name]) || Boolean(model.backend);
  return hasKey && hasBackend;
}

export function getModel(
  name: string = DEFAULT_MODEL,
  env: NodeJS.ProcessEnv = readEnv(),
): ModelDescriptor {
  const model = MODELS[name];
  if (!model) throw new Error(`Unknown model: ${name}`);
  if (model.status === "planned") {
    throw new Error(`${model.name} is not integrated yet — use ${DEFAULT_MODEL}.`);
  }
  return resolveBackend(model, env);
}

/** The variables that configure the monitor seat, which vision shares. */
export const SUPERVISOR_MODEL_ENVS = ["NOMIN_SUPERVISOR_MODEL", "NOMIN_VISION_MODEL"];

export const listModels = () => Object.values(MODELS);

/** All registered models for a role, including the ones not yet integrated. */
export const modelsForRole = (role: ModelRole) =>
  [...Object.values(MODELS), SUPERVISOR].filter((model) => model.role === role);
