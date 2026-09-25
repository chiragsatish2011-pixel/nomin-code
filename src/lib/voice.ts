/**
 * Voice: speaking to Nomin, and Nomin speaking back.
 *
 * Both halves run in the browser. Dictation uses the platform's own speech
 * recogniser and reading uses its synthesiser, which means no audio is
 * uploaded anywhere by Nomin, there is no extra credential to configure, and
 * it works while the agent's own rate budget is busy.
 *
 * Support is uneven — recognition is a Chromium and Safari feature, and some
 * builds ship it disabled — so everything here reports what it can do rather
 * than assuming, and the interface hides what is unavailable instead of
 * offering a button that does nothing.
 */

export interface VoiceSupport {
  listening: boolean;
  speaking: boolean;
  /** Why listening is unavailable, in words worth showing. */
  reason?: string;
}

type RecognitionHandle = {
  stop: () => void;
  abort: () => void;
};

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
}

function recogniser(): (new () => RecognitionLike) | null {
  const scope = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function voiceSupport(): VoiceSupport {
  const speaking = typeof window !== "undefined" && "speechSynthesis" in window;
  const Recognition = typeof window === "undefined" ? null : recogniser();
  if (!Recognition) {
    return {
      listening: false,
      speaking,
      reason:
        typeof window !== "undefined" && !window.isSecureContext
          ? "Speech input needs a secure connection."
          : "This browser has no speech recognition. Chrome, Edge and Safari do.",
    };
  }
  return { listening: true, speaking };
}

export interface ListenOptions {
  /** Text so far, updated as the speaker goes. */
  onPartial: (text: string) => void;
  /** The finished sentence, once the speaker stops. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  /** Keep listening after each sentence — used by conversation mode. */
  continuous?: boolean;
  language?: string;
}

/**
 * Listen once, or continuously.
 *
 * Interim results are reported as they arrive because watching the words
 * appear is how a speaker knows they are being heard; nothing is sent until
 * the recogniser marks a result final.
 */
export function listen(options: ListenOptions): RecognitionHandle | null {
  const Recognition = recogniser();
  if (!Recognition) {
    options.onError("Speech recognition is not available in this browser.");
    return null;
  }

  const recognition = new Recognition();
  recognition.lang = options.language ?? navigator.language ?? "en-US";
  recognition.continuous = Boolean(options.continuous);
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let settled = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result?.[0]?.transcript ?? "";
      if (result?.isFinal) settled += text;
      else interim += text;
    }
    const combined = `${settled}${interim}`.trim();
    if (combined) options.onPartial(combined);
    if (settled.trim() && !interim) {
      const finished = settled.trim();
      settled = "";
      options.onFinal(finished);
    }
  };

  recognition.onerror = (event) => {
    const code = event.error ?? "unknown";
    options.onError(
      code === "not-allowed"
        ? "Microphone access was refused."
        : code === "no-speech"
          ? "Nothing was heard."
          : `Speech input failed (${code}).`,
    );
  };

  recognition.onend = () => {
    // A trailing partial still counts as something the speaker said.
    if (settled.trim()) {
      const finished = settled.trim();
      settled = "";
      options.onFinal(finished);
    }
  };

  try {
    recognition.start();
  } catch {
    options.onError("Speech input could not start.");
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
    abort: () => {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * Read text aloud.
 *
 * Markdown, code fences and Nomin's own protocol blocks are stripped first:
 * hearing a model read out backticks and JSON is worse than hearing nothing.
 */
export function speak(text: string, onDone?: () => void): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const spoken = forSpeech(text);
  if (!spoken) {
    onDone?.();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spoken);
  utterance.rate = 1.03;
  utterance.pitch = 1;
  utterance.onend = () => onDone?.();
  utterance.onerror = () => onDone?.();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/** Turn an answer into something worth listening to. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[a-z-]*\n[\s\S]*?```/gi, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 4000);
}
