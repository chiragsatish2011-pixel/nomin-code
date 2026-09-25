import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "./components/Canvas.js";
import { Composer, type Mode } from "./components/Composer.js";
import { Mark } from "./components/Mark.js";
import { Markdown } from "./components/Markdown.js";
import { ParticleOrb } from "./components/ParticleOrb.js";
import { ReportCard } from "./components/ReportCard.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { PlanCard } from "./components/PlanCard.js";
import { QuestionCard } from "./components/QuestionCard.js";
import { parsePlan } from "./model/plan.js";
import { prepare, type PreparedAttachment } from "./lib/media.js";
import { readCanvas } from "./lib/artifacts.js";
import { useMonitor, type MonitorState } from "./lib/useMonitor.js";
import { formatAnswers, hasPartialBlock, parseQuestions } from "./lib/questions.js";
import { readTheme, storeTheme, watchSystemTheme, type Theme } from "./lib/theme.js";
import { useAgent, type ChatMessage, type Verdict } from "./lib/useAgent.js";
import type { Plan, PlanStatus } from "./model/plan.js";

const MODEL_NAME = "Trion 1.5";

const STARTERS = [
  "Build a landing page for a coffee shop",
  "Make a dashboard with three charts",
  "Write a small REST API",
  "Explain this project's architecture",
];

export default function App() {
  // Resolved once from storage, then the OS — so a hard refresh keeps it.
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [mode, setMode] = useState<Mode>("balanced");
  const [draft, setDraft] = useState("");
  // The canvas stays out of the way until it has something to show: the user
  // opens it, or the agent produces something runnable and it opens itself.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [canvasPinnedShut, setCanvasPinnedShut] = useState(false);
  const {
    messages,
    running,
    usage,
    status,
    cooldown,
    send,
    stop,
    reset,
    sessions,
    sessionId,
    openSession,
    plan,
    planStatus,
    approvePlan,
    requestPlanChanges,
    workspaceFiles,
  } = useAgent();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow the operating system until the user picks for themselves.
  useEffect(() => watchSystemTheme(setTheme), []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      storeTheme(next);
      return next;
    });
  }, []);

  const attach = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setAttaching(true);
    try {
      const prepared = await Promise.all(Array.from(files).map((file) => prepare(file)));
      setAttachments((current) => {
        const names = new Set(current.map((item) => item.name));
        return [...current, ...prepared.filter((item) => !names.has(item.name))];
      });
    } finally {
      setAttaching(false);
    }
  }, []);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((current) => current.filter((item) => item.name !== name));
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if ((!text && !attachments.length) || running) return;
    setDraft("");
    const pending = attachments;
    setAttachments([]);
    void send(text, mode, undefined, pending);
  }, [attachments, draft, mode, running, send]);

  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser && !running) void send(lastUser.content, mode);
  }, [messages, mode, running, send]);

  const answerQuestions = useCallback(
    (text: string) => {
      if (!running) void send(text, mode);
    },
    [mode, running, send],
  );

  const approveAndBuild = useCallback(() => {
    if (!plan) return;
    approvePlan();
    // The plan travels with the request, not through state: this call is what
    // unlocks the tools, so it cannot wait for a re-render.
    void send("Plan approved. Build it exactly as agreed.", mode, plan);
  }, [approvePlan, mode, plan, send]);

  const sendPlanChanges = useCallback(
    (note: string) => {
      const text = requestPlanChanges(note);
      if (text) void send(`Change the plan: ${text}`, mode);
    },
    [mode, requestPlanChanges, send],
  );

  const canvas = useMemo(() => readCanvas(messages), [messages]);
  const monitor = useMonitor(messages, canvas, running);
  const started = messages.length > 0;

  const runnable = canvas.kind === "html" || canvas.kind === "project";
  useEffect(() => {
    if (runnable && !canvasPinnedShut) setCanvasOpen(true);
  }, [runnable, canvasPinnedShut, canvas.artifacts.length]);

  const toggleCanvas = useCallback(() => {
    setCanvasOpen((open) => {
      setCanvasPinnedShut(open);
      return !open;
    });
  }, []);

  return (
    <div className={`workspace${canvasOpen ? " with-canvas" : ""}`}>
      <header className="taskbar">
        <div className="brand">
          <Mark size={24} busy={running} />
          <span className="brand-name">Nomin Code</span>
        </div>

        <div className="taskbar-mid" />

        <div className="taskbar-right">
          <span className="model-chip" title="The model running this workspace">
            <i className={`model-pip${running ? " live" : ""}`} />
            {MODEL_NAME}
          </span>
          <button
            className={`ghost-btn${canvasOpen ? " on" : ""}`}
            onClick={toggleCanvas}
            title={canvasOpen ? "Hide canvas" : "Show canvas"}
          >
            Canvas{canvas.artifacts.length ? ` ${canvas.artifacts.length}` : ""}
          </button>
          <button className="ghost-btn" onClick={toggleTheme}>
            {theme === "light" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      <div className="frame">
        <nav className="rail">
          <button className="new-task" onClick={reset}>
            <span>+</span> New session
          </button>

          <div className="rail-section">
            <span className="rail-caption">Today</span>
            {sessions.length || started ? (
              <ul className="session-list">
                {started && !sessions.some((item) => item.id === sessionId) && (
                  <li className="session on">{messages[0]?.content.slice(0, 44)}</li>
                )}
                {sessions.map((item) => (
                  <li key={item.id}>
                    <button
                      className={`session${item.id === sessionId ? " on" : ""}`}
                      onClick={() => void openSession(item.id)}
                      disabled={running}
                    >
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">Nothing yet. Describe what you want built.</p>
            )}
          </div>

          <div className="rail-section">
            <span className="rail-caption">State</span>
            <dl className="state-grid">
              <dt>Status</dt>
              <dd className={running ? "live" : ""}>{status}</dd>
              <dt>Mode</dt>
              <dd>{mode}</dd>
              <dt>Output</dt>
              <dd>{usage ? `${usage.completionTokens} tok` : "—"}</dd>
              <dt>Files</dt>
              <dd>{workspaceFiles.length || canvas.artifacts.length || "—"}</dd>
              <dt>Plan</dt>
              <dd>{planStatus === "none" ? "—" : planStatus}</dd>
              <dt>Review</dt>
              <dd className={monitor.verdict?.status === "verified" ? "live" : ""}>
                {monitor.status === "reviewing" || monitor.status === "capturing"
                  ? "checking"
                  : (monitor.verdict?.status ?? "—")}
              </dd>
            </dl>
          </div>

          <div className="rail-foot">
            <span className="rail-caption">Running on</span>
            <p className="rail-note">Nomin infrastructure</p>
          </div>
        </nav>

        <main className="stage">
          {cooldown && (
            <div className="cooldown-banner">
              <i className="spin" />
              {cooldown}
            </div>
          )}

          {started ? (
            <Chat
              messages={messages}
              running={running}
              status={status}
              theme={theme}
              retry={retry}
              answer={answerQuestions}
              usage={usage}
              monitor={monitor}
              plan={plan}
              planStatus={planStatus}
              onApprovePlan={approveAndBuild}
              onChangePlan={sendPlanChanges}
            />
          ) : (
            <Welcome running={running} pick={setDraft} />
          )}

          <div className={`composer-dock${started ? "" : " centred"}`}>
            <Composer
              draft={draft}
              setDraft={setDraft}
              submit={submit}
              stop={stop}
              running={running}
              status={status}
              mode={mode}
              setMode={setMode}
              placeholder={started ? "Reply, or ask for a change" : "Describe what you want built…"}
              attachments={attachments}
              onAttach={attach}
              onRemoveAttachment={removeAttachment}
              attaching={attaching}
            />
            <p className="disclaimer">
              Trion 1.5 can make mistakes. Nomin verifies work against real evidence — check anything
              marked unverified.
            </p>
          </div>
        </main>

        {canvasOpen && <Canvas state={canvas} running={running} onClose={toggleCanvas} />}
      </div>
    </div>
  );
}

function Welcome({ running, pick }: { running: boolean; pick: (text: string) => void }) {
  return (
    <div className="welcome">
      <ParticleOrb size={120} count={480} active />
      <h1>What are we building?</h1>
      <p>
        Describe the outcome. Nomin Code asks what it needs, plans it for your approval, then builds,
        tests and verifies the work — and keeps going through rate limits.
      </p>
      <ul className="starters">
        {STARTERS.map((text) => (
          <li key={text}>
            <button onClick={() => pick(text)} disabled={running}>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chat({
  messages,
  running,
  status,
  theme,
  retry,
  answer,
  usage,
  monitor,
  plan,
  planStatus,
  onApprovePlan,
  onChangePlan,
}: {
  messages: ChatMessage[];
  running: boolean;
  status: string;
  theme: Theme;
  retry: () => void;
  answer: (text: string) => void;
  usage: { promptTokens: number; completionTokens: number } | null;
  monitor: MonitorState;
  plan: Plan | null;
  planStatus: PlanStatus;
  onApprovePlan: () => void;
  onChangePlan: (note: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const startedAt = messages[0]?.at ?? Date.now();
  // The plan belongs to the turn that proposed it.
  const lastPlanTurn = messages.reduce(
    (found, message, i) =>
      message.role === "assistant" && parsePlan(message.content).plan ? i : found,
    -1,
  );

  return (
    <div className="chat">
      <div className="chat-inner">
        {messages.map((message, i) =>
          message.role === "user" ? (
            <UserTurn key={i} message={message} />
          ) : (
            <article key={i} className={`turn${message.error ? " failed" : ""}`}>
              {message.events?.length ? (
                <ThinkingBlock
                  events={message.events}
                  running={running && i === messages.length - 1}
                  status={status}
                  theme={theme}
                />
              ) : null}

              <div className="turn-text">
                {message.error ? (
                  message.content
                ) : (
                  <Markdown text={parsePlan(parseQuestions(message.content).text).text} />
                )}
                {running && i === messages.length - 1 && !message.content && (
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>

              {plan && i === lastPlanTurn && (
                <PlanCard
                  plan={plan}
                  status={planStatus}
                  running={running}
                  onApprove={onApprovePlan}
                  onChange={onChangePlan}
                />
              )}

              {!running && i === messages.length - 1 && !message.error && (
                <Clarify content={message.content} answer={answer} />
              )}

              {!running && message.content && (
                <MessageActions
                  text={message.content}
                  verdict={i === messages.length - 1 ? undefined : message.verdict}
                  retry={retry}
                />
              )}

              {!running && i === messages.length - 1 && !message.error && (
                <ReportCard monitor={monitor} />
              )}
            </article>
          ),
        )}

        {running && <SessionFooter startedAt={startedAt} status={status} usage={usage} />}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** A user message: quiet surface, relative time, actions on hover. */
function UserTurn({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = message.content.length > 420;
  const text = long && !expanded ? `${message.content.slice(0, 420).trimEnd()}…` : message.content;

  return (
    <article className="turn user">
      <div className="user-box">{text}</div>
      {long && (
        <button className="show-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <div className="user-foot">
        <time>{relative(message.at)}</time>
        <button
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(message.content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </article>
  );
}

/** The live line under an in-flight turn: elapsed, tokens, what it is doing. */
function SessionFooter({
  startedAt,
  status,
  usage,
}: {
  startedAt: number;
  status: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;

  return (
    <div className="session-footer">
      <span className="session-spark" />
      {formatDuration(seconds)}
      {tokens > 0 && ` · ${formatTokens(tokens)} tokens`} · {status}…
    </div>
  );
}

const formatDuration = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

function relative(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 minute ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Shows the selectable question card when the agent asked for requirements. */
function Clarify({ content, answer }: { content: string; answer: (text: string) => void }) {
  const [dismissed, setDismissed] = useState(false);
  const { questions } = useMemo(() => parseQuestions(content), [content]);
  if (dismissed || hasPartialBlock(content) || !questions.length) return null;
  return (
    <QuestionCard
      questions={questions}
      onDismiss={() => setDismissed(true)}
      onSubmit={(answers) => {
        setDismissed(true);
        answer(formatAnswers(questions, answers));
      }}
    />
  );
}

function MessageActions({
  text,
  verdict,
  retry,
}: {
  text: string;
  verdict?: Verdict;
  retry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="actions">
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={retry}>Retry</button>
      {verdict && (
        <span className={`verdict ${verdict.status}`} title={verdict.issues.join(" · ")}>
          {verdict.status === "verified"
            ? "Verified"
            : verdict.status === "unverified"
              ? "Unverified"
              : verdict.status === "concerns"
                ? "Concerns"
                : "Failed"}
          <em>{verdict.usedModel ? "supervisor" : "evidence"}</em>
        </span>
      )}
    </div>
  );
}

