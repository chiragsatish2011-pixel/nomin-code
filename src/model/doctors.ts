import { resolveBackend } from "./registry.js";
import type { ModelDescriptor, RetryPolicy } from "./registry.js";

/**
 * The doctor team.
 *
 * Six specialists that only run when Nomin itself is broken, and only on the
 * manager's command. They are deliberately *stronger* than the manager: the
 * manager's job is to notice and describe, theirs is to diagnose and repair.
 *
 * Each doctor holds its own credential. That is the whole point of the design —
 * six repairs can run at once without any of them consuming the worker's or the
 * manager's rate budget, and one doctor hitting a limit never stalls the rest.
 *
 * A doctor's *role* is written here, because the role is what the manager
 * splits work by. Which backend serves that role is not: each doctor names the
 * environment variable carrying its model identifier, so this file describes
 * the team without disclosing it. A doctor missing either half is off duty.
 */

export type DoctorId = "d1" | "d2" | "d3" | "d4" | "d5" | "d6";

export interface DoctorSpec {
  id: DoctorId;
  /** What this doctor is good at — drives how the manager splits the work. */
  role: string;
  /** One line the user may see. Never mentions models, vendors or code. */
  publicLabel: string;
  /**
   * The environment variable carrying this doctor's backend model identifier.
   * Read when the doctor is called, not when this module loads.
   */
  backendEnv: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
  temperature: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
};

/**
 * Roles are assigned by what breaks, not by model size alone. The two largest
 * models take diagnosis and the repair itself; the rest verify, hunt for
 * regressions, check the surface, and keep the record straight.
 */
export const DOCTORS: DoctorSpec[] = [
  {
    id: "d1",
    role: "diagnosis",
    publicLabel: "Tracing the fault",
    // Diagnosis gets the strongest model the deployment has, on its own key,
    // so it never competes with Trion for the worker budget.
    backendEnv: "NOMIN_DOCTOR_1_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_1_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0.1,
  },
  {
    id: "d2",
    role: "repair",
    publicLabel: "Writing the repair",
    backendEnv: "NOMIN_DOCTOR_2_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_2_API_KEY",
    maxOutputTokens: 8192,
    temperature: 0.15,
  },
  {
    id: "d3",
    role: "verification",
    publicLabel: "Checking the repair holds",
    backendEnv: "NOMIN_DOCTOR_3_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_3_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0,
  },
  {
    id: "d4",
    role: "regression",
    publicLabel: "Looking for knock-on damage",
    backendEnv: "NOMIN_DOCTOR_4_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_4_API_KEY",
    maxOutputTokens: 4096,
    temperature: 0.1,
  },
  {
    id: "d5",
    role: "surface",
    publicLabel: "Checking what the user sees",
    backendEnv: "NOMIN_DOCTOR_5_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_5_API_KEY",
    maxOutputTokens: 2048,
    temperature: 0,
  },
  {
    id: "d6",
    role: "record",
    publicLabel: "Recording what changed",
    backendEnv: "NOMIN_DOCTOR_6_MODEL",
    apiKeyEnv: "NOMIN_DOCTOR_6_API_KEY",
    maxOutputTokens: 2048,
    temperature: 0,
  },
];

export function doctorModel(spec: DoctorSpec, env = process.env): ModelDescriptor {
  return resolveBackend({
    name: `Doctor ${spec.id.toUpperCase()}`,
    role: "supervisor",
    status: "available",
    backendEnv: spec.backendEnv,
    provider: "nvidia",
    apiKeyEnv: spec.apiKeyEnv,
    contextTokens: 128_000,
    maxOutputTokens: spec.maxOutputTokens,
    capabilities: { tools: false, streaming: true, reasoning: true, vision: spec.id === "d5" },
    retry: DEFAULT_RETRY,
    timeoutMs: 180_000,
    notes: `Repair role: ${spec.role}. Never talks to the user directly.`,
  }, env);
}

/**
 * Which doctors could actually work right now. A doctor needs both its own
 * credential and a model to spend it on; counting one without the other is how
 * "6 of 6 configured" ends up in front of a team that cannot run.
 */
export function availableDoctors(env = process.env): DoctorSpec[] {
  return DOCTORS.filter((doctor) => Boolean(env[doctor.apiKeyEnv] && env[doctor.backendEnv]));
}
