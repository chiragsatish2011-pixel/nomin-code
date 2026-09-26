import { CrpmScheduler, splitWork } from "./crpm.js";
import { NvidiaProvider } from "./nvidia.js";
import { endpointOf, SUPERVISOR, SUPERVISOR_MODEL_ENVS, type ModelDescriptor } from "./registry.js";
import type { ContentPart, Message } from "./types.js";

/**
 * The vision fallback.
 *
 * Trion reads text, not pixels. So anything visual is handled by a second,
 * multimodal model whose only job is to turn frames into words — a description
 * precise enough that the main model can work from it as if it had looked
 * itself. The image never reaches Trion; the description does.
 *
 * Video is the same mechanism with more frames. The clip is sampled, the
 * frames are read in small batches, and the batches are then drawn together
 * into one account of what happens over time. Batching is not an
 * optimisation — it is what keeps a twelve-frame clip from becoming twelve
 * simultaneous requests on one credential.
 *
 * Every call is booked through CRPM, so reading a long video never starves the
 * manager or the doctors of their own budget.
 */

export interface VisionFrame {
  at: number;
  dataUrl: string;
}

export interface VisionRequest {
  name: string;
  kind: "image" | "video";
  frames: VisionFrame[];
  duration?: number;
  /** What the user actually asked, so the description answers it. */
  question?: string;
}

export interface VisionResult {
  name: string;
  kind: "image" | "video";
  /** The description handed to the main model. */
  description: string;
  /** Per-batch notes, kept for the UI's detail view. */
  notes: Array<{ at: number; text: string }>;
  frames: number;
  failed?: string;
}

/** Frames per call. Two gives the model a sense of motion without bloating one request. */
const FRAMES_PER_CALL = 2;
const LANE = "vision";

const scheduler = new CrpmScheduler({ [LANE]: { rpm: 30, concurrency: 2 } });

function visionModel(env: NodeJS.ProcessEnv): { model: ModelDescriptor; key: string } | null {
  // The monitor's multimodal model does this job too; it is already on its own
  // credential, which is exactly what CRPM wants.
  const key = env.NOMIN_VISION_API_KEY ?? env[SUPERVISOR.apiKeyEnv ?? ""] ?? "";
  // Its own model variable when the deployment gives it one, the monitor's
  // otherwise — the same seat serves both. No identifier is written here, so
  // without either variable vision is simply unavailable and says so.
  const backend = SUPERVISOR_MODEL_ENVS.map((name) => (env[name] ?? "").trim()).find(Boolean) ?? "";
  if (!key || !backend) return null;
  return {
    model: {
      ...SUPERVISOR,
      name: "Nomin Vision",
      // Already resolved: the descriptor carries the value, not the variable.
      backendEnv: undefined,
      backend,
      endpoint: endpointOf(undefined, env),
      maxOutputTokens: 700,
    },
    key,
  };
}

export function visionAvailable(env = process.env): boolean {
  return visionModel(env) !== null;
}

export async function describeMedia(
  request: VisionRequest,
  env = process.env,
): Promise<VisionResult> {
  const configured = visionModel(env);
  const base: VisionResult = {
    name: request.name,
    kind: request.kind,
    description: "",
    notes: [],
    frames: request.frames.length,
  };

  if (!configured) {
    return { ...base, failed: "No vision credential is configured." };
  }
  if (!request.frames.length) {
    return { ...base, failed: "Nothing could be extracted from that file." };
  }

  const provider = new NvidiaProvider(configured.model, configured.key);
  const batches = splitWork(request.frames, request.kind === "image" ? 1 : FRAMES_PER_CALL);

  // Batches go through the scheduler, so a long clip is paced rather than
  // fired all at once.
  const notes = await Promise.all(
    batches.map((batch, index) =>
      scheduler.run(LANE, async () => {
        const read = await readBatch(provider, request, batch, index, batches.length);
        return { at: batch[0]?.at ?? 0, text: read.text, error: read.error };
      }),
    ),
  );

  const usable = notes.filter((note) => note.text.trim());
  if (!usable.length) {
    const reason = notes.find((note) => note.error)?.error;
    return { ...base, failed: reason ?? "The vision model returned nothing for those frames." };
  }

  // One image needs no synthesis; a video does.
  const description =
    request.kind === "image" || usable.length === 1
      ? usable[0]!.text
      : await scheduler.run(LANE, () => synthesise(provider, request, usable));

  return { ...base, description, notes: usable };
}

async function readBatch(
  provider: NvidiaProvider,
  request: VisionRequest,
  frames: VisionFrame[],
  index: number,
  total: number,
): Promise<{ text: string; error?: string }> {
  const position =
    request.kind === "video"
      ? `These are frames ${index + 1} of ${total} from a ${format(request.duration)} video, at ${frames
          .map((frame) => format(frame.at))
          .join(" and ")}.`
      : "This is a single image.";

  const parts: ContentPart[] = [
    {
      type: "text",
      text: [
        position,
        request.question ? `The person asked: "${request.question}"` : "",
        "Describe exactly what is visible, in plain sentences. Include any text you can read, verbatim. Name layout, colours, and anything that looks broken or unfinished. Do not speculate about what is outside the frame. No preamble.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    ...frames.map((frame) => ({ type: "image_url" as const, image_url: { url: frame.dataUrl } })),
  ];

  const messages: Message[] = [
    { role: "system", content: "You describe images for an engineering agent that cannot see them. Be accurate and concrete. Never invent detail." },
    { role: "user", content: parts },
  ];

  let text = "";
  let error: string | undefined;
  for await (const event of provider.stream({ messages, maxTokens: 1400, temperature: 0 })) {
    if (event.type === "delta") text += event.text;
    if (event.type === "rate_limit") scheduler.throttle(LANE, event.waitSeconds);
    if (event.type === "error") error = event.message;
  }
  // A reasoning model can spend its whole budget thinking and return nothing.
  if (!text.trim() && !error) error = "The vision model produced no description.";
  return { text: text.trim(), error };
}

/** Draw the per-batch notes into one account of the whole clip. */
async function synthesise(
  provider: NvidiaProvider,
  request: VisionRequest,
  notes: Array<{ at: number; text: string }>,
): Promise<string> {
  const timeline = notes.map((note) => `[${format(note.at)}] ${note.text}`).join("\n\n");
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You turn frame-by-frame notes into one description of a video, for an agent that cannot watch it. State what happens and what changes between frames. Do not invent anything that is not in the notes.",
    },
    {
      role: "user",
      content: [
        `Video: ${request.name}${request.duration ? `, ${format(request.duration)} long` : ""}.`,
        request.question ? `The person asked: "${request.question}"` : "",
        "Frame notes:",
        timeline,
        "Write one description: what the video shows, what changes over time, and any text that appears. Then one line on anything that looks broken.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  let text = "";
  for await (const event of provider.stream({ messages, maxTokens: 700, temperature: 0.1 })) {
    if (event.type === "delta") text += event.text;
    if (event.type === "rate_limit") scheduler.throttle(LANE, event.waitSeconds);
    if (event.type === "error") break;
  }
  return text.trim() || timeline;
}

/**
 * The block handed to Trion. It is explicit about being second-hand: the model
 * should reason from a description, not pretend it looked at the file.
 */
export function visionContext(results: VisionResult[]): string {
  const usable = results.filter((result) => !result.failed && result.description);
  if (!usable.length) return "";

  const blocks = usable.map((result) => {
    const header =
      result.kind === "video"
        ? `VIDEO: ${result.name} (${result.frames} frames sampled)`
        : `IMAGE: ${result.name}`;
    return `${header}\n${result.description}`;
  });

  return [
    "The person attached media you cannot see. It was read for you and described below. Work from these descriptions, and say so if something you need was not captured.",
    ...blocks,
  ].join("\n\n");
}

const format = (seconds?: number) => {
  if (!Number.isFinite(seconds) || seconds === undefined) return "unknown length";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};
