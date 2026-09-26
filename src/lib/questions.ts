import { parseLooseJson } from "../model/tooltext.js";
/**
 * Clarification questions.
 *
 * Before planning substantial work the agent is allowed to ask for what it is
 * missing — but as structured, selectable choices rather than a paragraph of
 * "could you tell me…". The model emits a fenced `nomin-questions` block; this
 * module lifts it out of the answer, so the prose stays readable and the
 * questions become real UI.
 */

export interface QuestionOption {
  label: string;
  detail?: string;
}

export interface Question {
  id: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multi?: boolean;
}

export interface ParsedAnswer {
  /** The answer text with the question block removed. */
  text: string;
  questions: Question[];
}

const BLOCK = /```nomin-questions\s*\n([\s\S]*?)```/;

/** Split an answer into prose and questions. Malformed blocks are ignored. */
export function parseQuestions(answer: string): ParsedAnswer {
  const match = BLOCK.exec(answer);
  if (!match?.[1]) return { text: answer, questions: [] };

  let questions: Question[] = [];
  try {
    // Tolerant, for the same reason the plan block is: losing a round of
    // questions to a stray brace costs the user the whole turn.
    const parsed = parseLooseJson(match[1]) as { questions?: unknown } | null;
    if (!parsed) return { text: answer.replace(BLOCK, "").trimEnd(), questions: [] };
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    questions = list
      .map((raw, index) => normalise(raw, index))
      .filter((question): question is Question => question !== null)
      .slice(0, 6);
  } catch {
    // A half-streamed block is not an error — it just is not ready yet.
    return { text: answer.replace(BLOCK, "").trimEnd(), questions: [] };
  }

  return { text: answer.replace(BLOCK, "").trimEnd(), questions };
}

/** True while a question block is still arriving, so the UI can wait. */
export const hasPartialBlock = (answer: string) =>
  answer.includes("```nomin-questions") && !BLOCK.test(answer);

function normalise(raw: unknown, index: number): Question | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) return null;

  const options = Array.isArray(value.options)
    ? value.options
        .map((option) => {
          if (typeof option === "string") return { label: option.trim() };
          if (option && typeof option === "object") {
            const record = option as Record<string, unknown>;
            const label = typeof record.label === "string" ? record.label.trim() : "";
            if (!label) return null;
            const detail = typeof record.detail === "string" ? record.detail.trim() : undefined;
            return { label, detail };
          }
          return null;
        })
        .filter((option): option is QuestionOption => option !== null)
        .slice(0, 5)
    : [];

  if (!options.length) return null;

  return {
    id: typeof value.id === "string" && value.id ? value.id : `q${index + 1}`,
    question,
    header: typeof value.header === "string" ? value.header.slice(0, 24) : undefined,
    options,
    multi: value.multi === true,
  };
}

/** Turn the user's selections into the reply that goes back to the agent. */
export function formatAnswers(
  questions: Question[],
  answers: Record<string, string[]>,
): string {
  const lines = questions.map((question) => {
    const picked = answers[question.id];
    if (!picked?.length) return `${question.question}\n→ (skipped — use your best judgement)`;
    return `${question.question}\n→ ${picked.join(", ")}`;
  });
  return lines.join("\n\n");
}
