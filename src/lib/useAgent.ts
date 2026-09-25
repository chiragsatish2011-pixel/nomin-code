import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@nomin/work-tree";
import { parsePlan, type Plan, type PlanStatus } from "../model/plan.js";
import {
  listSessions,
  loadLastSession,
  loadSession,
  newSessionId,
  saveSession,
  titleFor,
  type SessionRecord,
} from "./persist.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  at: number;
  /** The work-tree events belonging to this turn — kept per turn, not global. */
  events?: AgentEvent[];
  verdict?: Verdict;
}

export interface Verdict {
  status: "verified" | "concerns" | "failed" | "unverified";
  summary: string;
  issues: string[];
  evidence: string[];
  usedModel: boolean;
  /** True when the monitor looked at a rendering, not only the code. */
  sawRendering?: boolean;
  /** The monitor's written report, in markdown. */
  report?: string;
}

export interface WorkspaceFileRef {
  path: string;
  bytes: number;
}

interface Frame {
  kind: "tree" | "text" | "error" | "usage" | "verdict" | "files" | "end";
  files?: WorkspaceFileRef[];
  verdict?: Verdict;
  text?: string;
  message?: string;
  event?: AgentEvent;
  promptTokens?: number;
  completionTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Talks to the agent endpoint and splits its stream into the two things the
 * UI shows: the answer, and the work-tree event log.
 */
export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sessionId, setSessionId] = useState(newSessionId);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planStatus, setPlanStatus] = useState<PlanStatus>("none");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRef[]>([]);
  const [restored, setRestored] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Restore the last session on open, so a reload resumes rather than resets.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [record, all] = await Promise.all([loadLastSession(), listSessions()]);
      if (!live) return;
      setSessions(all);
      if (record) {
        setSessionId(record.id);
        setMessages(record.messages);
        setPlan(record.plan);
        setPlanStatus(record.planStatus);
        setEvents(record.messages[record.messages.length - 1]?.events ?? []);
      }
      setRestored(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Persist whenever the conversation or the plan moves on.
  useEffect(() => {
    if (!restored || running || !messages.length) return;
    const record: SessionRecord = {
      id: sessionId,
      title: titleFor(messages),
      createdAt: messages[0]?.at ?? Date.now(),
      updatedAt: Date.now(),
      messages,
      plan,
      planStatus,
      step: 0,
      mode: "balanced",
    };
    const timer = window.setTimeout(() => {
      void saveSession(record).then(() => listSessions().then(setSessions));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [messages, plan, planStatus, restored, running, sessionId]);

  // Only tick while a cooldown is actually running.
  useEffect(() => {
    if (waitUntil === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [waitUntil]);

  const reset = useCallback(() => {
    abort.current?.abort();
    setSessionId(newSessionId());
    setMessages([]);
    setEvents([]);
    setUsage(null);
    setWaitUntil(null);
    setRunning(false);
    setPlan(null);
    setPlanStatus("none");
    setWorkspaceFiles([]);
  }, []);

  /** Open a stored session and continue it where it stopped. */
  const openSession = useCallback(async (id: string) => {
    abort.current?.abort();
    const record = await loadSession(id);
    if (!record) return;
    setSessionId(record.id);
    setMessages(record.messages);
    setPlan(record.plan);
    setPlanStatus(record.planStatus);
    setEvents(record.messages[record.messages.length - 1]?.events ?? []);
    setUsage(null);
    setWaitUntil(null);
    setRunning(false);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    setRunning(false);
  }, []);

  const send = useCallback(
    async (
      text: string,
      mode: "quick" | "balanced" | "deep" = "balanced",
      // Passed explicitly on approval: reading it from state here would use
      // the value captured before the click, and the tools would never unlock.
      planOverride?: Plan | null,
    ) => {
      const prompt = text.trim();
      if (!prompt || abort.current) return;

      const now = Date.now();
      const history: ChatMessage[] = [...messages, { role: "user", content: prompt, at: now }];
      setMessages([...history, { role: "assistant", content: "", at: now, events: [] }]);
      setEvents([]);
      setUsage(null);
      setWaitUntil(null);
      setRunning(true);

      const controller = new AbortController();
      abort.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            title: prompt.split("\n")[0]?.slice(0, 60) ?? "Task",
            messages: history.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (!response.body) throw new Error("No response stream");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let cut = buffer.indexOf("\n\n");
          while (cut !== -1) {
            const raw = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf("\n\n");
            if (!raw.startsWith("data:")) continue;

            let frame: Frame;
            try {
              frame = JSON.parse(raw.slice(5).trim()) as Frame;
            } catch {
              continue;
            }
            apply(frame);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Request failed";
          setMessages((prev) => appendError(prev, message));
        }
      } finally {
        abort.current = null;
        setRunning(false);
      }

      function apply(frame: Frame) {
        if (frame.kind === "text" && frame.text) {
          setMessages((prev) => {
            const next = appendText(prev, frame.text!);
            const last = next[next.length - 1];
            if (last?.role === "assistant" && planStatus !== "approved") {
              const found = parsePlan(last.content).plan;
              if (found) {
                setPlan(found);
                setPlanStatus("proposed");
              }
            }
            return next;
          });
        } else if (frame.kind === "tree" && frame.event) {
          const event = frame.event;
          if (event.type === "cooldown.started") {
            setWaitUntil(Date.now() + (event.waitSeconds ?? 0) * 1000);
          } else if (event.type === "cooldown.completed" || event.type === "agent.resumed") {
            setWaitUntil(null);
          }
          setEvents((prev) => [...prev, event]);
          setMessages((prev) => attachEvent(prev, event));
        } else if (frame.kind === "usage") {
          setUsage({
            promptTokens: frame.promptTokens ?? 0,
            completionTokens: frame.completionTokens ?? 0,
          });
        } else if (frame.kind === "files" && frame.files) {
          setWorkspaceFiles(frame.files);
        } else if (frame.kind === "verdict" && frame.verdict) {
          const verdict = frame.verdict;
          setMessages((prev) => attachVerdict(prev, verdict));
        } else if (frame.kind === "error" && frame.message) {
          setMessages((prev) => appendError(prev, frame.message!));
        }
      }
    },
    [messages, plan, planStatus, sessionId],
  );

  /** Approve the plan. This is what unlocks the tools for the next turn. */
  const approvePlan = useCallback(() => {
    if (!plan) return;
    setPlanStatus("approved");
  }, [plan]);

  /** Send the plan back with changes; the agent replans, still without tools. */
  const requestPlanChanges = useCallback((note: string) => {
    setPlanStatus("changes-requested");
    return note.trim();
  }, []);

  const secondsLeft = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;

  /** One plain line describing what the agent is doing — never its reasoning. */
  const status = useMemo(() => {
    if (waitUntil) return `Rate limited · resuming in ${secondsLeft}s`;
    if (!running) return messages.length ? "Ready" : "Idle";
    const last = [...events].reverse().find((event) => STATUS_TEXT[event.type]);
    return last ? STATUS_TEXT[last.type]! : "Working";
  }, [events, messages.length, running, secondsLeft, waitUntil]);

  const cooldown = waitUntil
    ? `Rate limit reached. Waiting ${secondsLeft}s for cooldown. Work state preserved — resuming the same step.`
    : null;

  return {
    messages,
    events,
    running,
    usage,
    status,
    cooldown,
    send,
    stop,
    reset,
    sessionId,
    sessions,
    openSession,
    plan,
    planStatus,
    approvePlan,
    requestPlanChanges,
    workspaceFiles,
  };
}

/** Events and verdicts belong to the turn that produced them. */
function attachEvent(messages: ChatMessage[], event: AgentEvent): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role !== "assistant") return messages;
  next[next.length - 1] = { ...last, events: [...(last.events ?? []), event] };
  return next;
}

function attachVerdict(messages: ChatMessage[], verdict: Verdict): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role !== "assistant") return messages;
  next[next.length - 1] = { ...last, verdict };
  return next;
}

function appendText(messages: ChatMessage[], text: string): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === "assistant") {
    next[next.length - 1] = { ...last, content: last.content + text };
  } else {
    next.push({ role: "assistant", content: text, at: Date.now() });
  }
  return next;
}

function appendError(messages: ChatMessage[], message: string): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === "assistant" && !last.content) {
    next[next.length - 1] = { ...last, content: message, error: true };
    return next;
  }
  next.push({ role: "assistant", content: message, error: true, at: Date.now() });
  return next;
}

/** Event → the short, user-facing status line for that moment. */
const STATUS_TEXT: Record<string, string> = {
  "task.started": "Starting",
  "thinking.started": "Thinking",
  "thinking.completed": "Working",
  "step.started": "Writing response",
  "step.completed": "Response complete",
  "step.failed": "Failed",
  "tool.started": "Running a tool",
  "cooldown.started": "Waiting for cooldown",
  "cooldown.completed": "Cooldown complete",
  "agent.resumed": "Resuming",
  "task.completed": "Complete",
};
