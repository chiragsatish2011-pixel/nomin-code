import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@nomin/work-tree";
import { parsePlan, type Plan, type PlanStatus } from "../model/plan.js";
import type { PreparedAttachment } from "./media.js";
import {
  chooseBuild,
  emptySnapshot,
  fetchWorkspace,
  filesForTurn,
  mergeFiles,
  type WorkspaceSnapshot,
} from "./workspace.js";
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
  /** What was attached to this message, so the transcript still shows it. */
  attachments?: Array<{ name: string; kind: string; note?: string }>;
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptySnapshot);
  // send() is a callback; a ref keeps it reading the live snapshot rather than
  // whatever was captured when it was created.
  const workspaceRef = useRef<WorkspaceSnapshot>(emptySnapshot);
  workspaceRef.current = workspace;
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  const [activeBuild, setActiveBuild] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [visionStatus, setVisionStatus] = useState<string | null>(null);
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
        const stored = record.workspace?.length
          ? mergeFiles(emptySnapshot, record.workspace)
          : await fetchWorkspace(record.id);
        if (live) {
          setWorkspace(stored);
          setActiveBuild(stored.builds[0]?.entry ?? null);
        }
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
      workspace: workspace.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        content: file.content,
      })),
    };
    const timer = window.setTimeout(() => {
      void saveSession(record).then(() => listSessions().then(setSessions));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [messages, plan, planStatus, restored, running, sessionId, workspace]);

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
    setWorkspace(emptySnapshot);
    setActiveBuild(null);
  }, []);

  /** Open a stored session and continue it where it stopped. */
  const openSession = useCallback(async (id: string) => {
    abort.current?.abort();
    const record = await loadSession(id);
    if (!record) return;
    const stored = record.workspace?.length
      ? mergeFiles(emptySnapshot, record.workspace)
      : await fetchWorkspace(id);
    setWorkspace(stored);
    setActiveBuild(stored.builds[0]?.entry ?? null);
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
      attachments?: PreparedAttachment[],
    ) => {
      const prompt = text.trim();
      if (!prompt || abort.current) return;

      // Anything visual is read first: Trion cannot see, so the frames become
      // a description before the turn begins, and the description is what
      // travels with the request.
      let mediaContext = "";
      if (attachments?.length) {
        setVisionStatus("Reading the attachments");
        mediaContext = await describeAttachments(attachments, prompt);
        setVisionStatus(null);
      }

      const now = Date.now();
      const history: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content: prompt,
          at: now,
          attachments: attachments?.map((item) => ({
            name: item.name,
            kind: item.kind,
            note: item.problem ?? describeAttachment(item),
          })),
        },
      ];
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
            mode,
            sessionId,
            // The gate: a plan only travels once it has been approved, and the
            // server only hands out tools when one arrives.
            plan: planOverride ?? (planStatus === "approved" ? plan : null),
            // The workspace travels with it — a serverless host keeps no disk
            // of its own between requests.
            files: filesForTurn(workspaceRef.current),
            messages: history.map(({ role, content }, index) =>
              // The description rides with the turn it belongs to.
              index === history.length - 1 && mediaContext
                ? { role, content: `${mediaContext}

---

${content}` }
                : { role, content },
            ),
          }),
        });

        // A deployment without the backend answers with the SPA's index.html.
        // Saying so beats a silent stream that never produces a token.
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.includes("text/event-stream")) {
          throw new Error(
            response.status === 404 || contentType.includes("text/html")
              ? "The agent backend is not responding on this deployment. Check that the API functions are deployed and the credentials are set."
              : `The agent backend returned ${response.status}.`,
          );
        }
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

        // On a host that keeps a disk between requests this catches anything
        // the stream missed. Where it does not, the client's own copy stands.
        const fromDisk = await fetchWorkspace(sessionId);
        if (fromDisk.files.length) {
          setWorkspace((previous) => {
            const next = mergeFiles(previous, fromDisk.files);
            setActiveBuild((current) => chooseBuild(previous, next, current));
            return next;
          });
        }
      }

      function apply(frame: Frame) {
        if (frame.kind === "text" && frame.text) {
          setMessages((prev) => {
            const next = appendText(prev, frame.text!);
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              const found = parsePlan(last.content).plan;
              // A new plan supersedes the approved one — otherwise a second,
              // different task in the same session would silently keep
              // building against the plan agreed for the first.
              if (found && planSignature(found) !== planSignature(planRef.current)) {
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
          // Rounds accumulate: a turn that called tools six times spent all six.
          setUsage((previous) => ({
            promptTokens: (previous?.promptTokens ?? 0) + (frame.promptTokens ?? 0),
            completionTokens: (previous?.completionTokens ?? 0) + (frame.completionTokens ?? 0),
          }));
        } else if (frame.kind === "files" && frame.files) {
          setWorkspaceFiles(frame.files.map(({ path, bytes }) => ({ path, bytes })));
          setWorkspace((previous) => {
            const next = mergeFiles(previous, frame.files!);
            setActiveBuild((current) => chooseBuild(previous, next, current));
            return next;
          });
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
    if (visionStatus) return visionStatus;
    if (waitUntil) return `Rate limited · resuming in ${secondsLeft}s`;
    if (!running) return messages.length ? "Ready" : "Idle";
    const last = [...events].reverse().find((event) => STATUS_TEXT[event.type]);
    return last ? STATUS_TEXT[last.type]! : "Working";
  }, [events, messages.length, running, secondsLeft, visionStatus, waitUntil]);

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
    workspace,
    activeBuild,
    setActiveBuild,
  };
}

/** One line saying what was actually taken from an attachment. */
function describeAttachment(item: PreparedAttachment): string | undefined {
  if (item.kind === "video") return `${item.frames.length} frames read`;
  if (item.kind === "image") return "read by vision";
  if (item.kind === "document") return item.sections ? `${item.sections} sections read` : "text read";
  if (item.kind === "text") return "text read";
  return undefined;
}

/** Two plans are the same plan when they aim at the same work. */
function planSignature(plan: Plan | null): string {
  if (!plan) return "";
  return `${plan.objective}|${plan.steps.map((step) => step.title).join(">")}`;
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

/**
 * Hand the frames to the vision model and get words back. A failure here is
 * reported to the agent rather than hidden: it should know it was shown
 * something it could not see.
 */
async function describeAttachments(
  attachments: PreparedAttachment[],
  question: string,
): Promise<string> {
  const media = attachments
    .filter((item) => item.frames.length && (item.kind === "image" || item.kind === "video"))
    .map((item) => ({
      name: item.name,
      kind: item.kind,
      duration: item.duration,
      frames: item.frames,
    }));

  const textFiles = attachments.filter((item) => item.text);
  const unreadable = attachments.filter((item) => item.problem);

  let context = "";
  if (media.length) {
    try {
      const response = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, media }),
      });
      const data = (await response.json()) as { context?: string; results?: Array<{ name: string; failed?: string }> };
      context = data.context ?? "";
      const failed = (data.results ?? []).filter((result) => result.failed);
      if (failed.length) {
        context += `

Could not read: ${failed.map((item) => `${item.name} (${item.failed})`).join(", ")}`;
      }
    } catch {
      context = `Attached media could not be read: ${media.map((item) => item.name).join(", ")}.`;
    }
  }

  const parts = [context];
  for (const file of textFiles) {
    parts.push(`ATTACHED FILE: ${file.name}

${file.text}`);
  }
  if (unreadable.length) {
    parts.push(`Attached but not read: ${unreadable.map((item) => item.name).join(", ")}.`);
  }
  return parts.filter(Boolean).join("\n\n");
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
