/**
 * Turning what the user drops in into something a text model can be told about.
 *
 * Trion cannot read pixels, so an image or a video has to become *words* before
 * it reaches the main model. That happens in two stages: this module reduces
 * the media to a small number of frames, and the vision model turns those
 * frames into a description.
 *
 * Frame-breaking is done with `<video>` and a canvas rather than ffmpeg. It
 * needs no native dependency, it works on anything the browser can already
 * decode, and it keeps the raw file on the user's machine — only the frames
 * that are actually going to be looked at ever leave it. When a server-side
 * ffmpeg is available it takes over for formats the browser refuses.
 */

export type AttachmentKind = "image" | "video" | "text" | "other";

export interface Frame {
  /** Seconds into the video. 0 for a still image. */
  at: number;
  /** JPEG data URL, already downscaled. */
  dataUrl: string;
}

export interface PreparedAttachment {
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** Frames to be looked at — one for an image, several for a video. */
  frames: Frame[];
  /** Text content, for files that are already words. */
  text?: string;
  /** Video length in seconds, when known. */
  duration?: number;
  /** Why nothing could be extracted, in plain words. */
  problem?: string;
}

const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.72;
const MAX_TEXT_BYTES = 200_000;
const SEEK_TIMEOUT_MS = 8000;

/** How many frames to sample, by how long the video runs. */
export function frameBudget(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 4;
  if (duration <= 5) return 4;
  if (duration <= 30) return 6;
  if (duration <= 120) return 8;
  return 12;
}

export function classify(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("text/") || /\.(txt|md|json|csv|ts|tsx|js|jsx|css|html|py|sh|yml|yaml)$/i.test(file.name)) {
    return "text";
  }
  return "other";
}

export async function prepare(file: File): Promise<PreparedAttachment> {
  const kind = classify(file);
  const base = { name: file.name, kind, bytes: file.size, frames: [] as Frame[] };

  try {
    if (kind === "image") {
      return { ...base, frames: [{ at: 0, dataUrl: await downscaleImage(file) }] };
    }
    if (kind === "video") {
      const { frames, duration } = await extractFrames(file);
      if (!frames.length) {
        return { ...base, problem: "This browser could not decode that video format." };
      }
      return { ...base, frames, duration };
    }
    if (kind === "text") {
      const text = await file.slice(0, MAX_TEXT_BYTES).text();
      return { ...base, text };
    }
    return { ...base, problem: "Attached for reference; its contents were not read." };
  } catch (error) {
    return { ...base, problem: error instanceof Error ? error.message : "Could not read that file." };
  }
}

/** Shrink an image so a vision call stays small and fast. */
async function downscaleImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * Break a video into evenly spaced frames.
 *
 * Seeking is done one frame at a time and awaited, because a browser will
 * happily report a seek complete and paint the previous frame if you rush it.
 */
async function extractFrames(file: File): Promise<{ frames: Frame[]; duration: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    const reported = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The video took too long to open.")), SEEK_TIMEOUT_MS);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(video.duration);
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("This browser could not decode that video."));
      };
    });

    const duration = await settleDuration(video, reported);

    const count = frameBudget(duration);
    const canvas = document.createElement("canvas");
    const frames: Frame[] = [];

    for (let i = 0; i < count; i++) {
      // Sample inside the clip, never exactly at the ends: the first and last
      // frames of a video are very often black.
      const at = Number.isFinite(duration) && duration > 0
        ? ((i + 0.5) / count) * duration
        : i * 0.5;
      const frame = await grab(video, canvas, at);
      if (frame) frames.push({ at, dataUrl: frame });
    }

    return { frames, duration };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Recorded WebM files routinely carry a wrong or infinite duration in their
 * header — MediaRecorder output especially. Seeking past the end forces the
 * browser to work the real length out, which is the difference between
 * sampling a whole clip and sampling its first second.
 */
function settleDuration(video: HTMLVideoElement, reported: number): Promise<number> {
  if (Number.isFinite(reported) && reported > 1) return Promise.resolve(reported);

  return new Promise((resolve) => {
    const finish = (value: number) => {
      video.removeEventListener("durationchange", onChange);
      video.currentTime = 0;
      resolve(Number.isFinite(value) && value > 0 ? value : reported);
    };
    const timer = setTimeout(() => finish(video.duration), 2500);
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        clearTimeout(timer);
        finish(video.duration);
      }
    };
    video.addEventListener("durationchange", onChange);
    try {
      video.currentTime = 1e6;
    } catch {
      clearTimeout(timer);
      finish(reported);
    }
  });
}

function grab(video: HTMLVideoElement, canvas: HTMLCanvasElement, at: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SEEK_TIMEOUT_MS);
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
        canvas.width = Math.max(1, Math.round((video.videoWidth || MAX_EDGE) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || MAX_EDGE) * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch {
        resolve(null);
      }
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = at;
    } catch {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve(null);
    }
  });
}

/** Roughly how much a set of attachments weighs, for the UI. */
export const totalFrames = (attachments: PreparedAttachment[]) =>
  attachments.reduce((sum, item) => sum + item.frames.length, 0);
