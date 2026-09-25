import { useEffect, useMemo, useState } from "react";
import type { Artifact, CanvasState } from "../lib/artifacts.js";
import { assemble, type Build, type WorkspaceSnapshot } from "../lib/workspace.js";
import { checkSupport, runProject, type RunState } from "../lib/webcontainer.js";

type Tab = "preview" | "code";
type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORTS: Record<Viewport, { label: string; width: number | null; height: number | null }> = {
  desktop: { label: "Desktop", width: null, height: null },
  tablet: { label: "Tablet", width: 834, height: 1112 },
  mobile: { label: "Mobile", width: 390, height: 844 },
};

/**
 * The canvas — where what the agent built is actually run, not just described.
 *
 * A single page renders straight into a sandboxed iframe. A multi-file project
 * boots in a WebContainer (a real Node runtime in the browser) so `npm
 * install` and the dev server run for real. When neither is possible the panel
 * says exactly why rather than showing a hopeful placeholder.
 */
export function Canvas({
  state,
  running,
  onClose,
  workspace,
  activeBuild,
  onSelectBuild,
}: {
  state: CanvasState;
  running: boolean;
  onClose: () => void;
  workspace: WorkspaceSnapshot;
  activeBuild: string | null;
  onSelectBuild: (entry: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("preview");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState(0);

  const project = useProject(state, nonce);
  const frame = VIEWPORTS[viewport];

  // The workspace is the truth when the agent used tools; the chat is only the
  // fallback for quick answers that never opened one.
  const build = workspace.builds.find((item) => item.entry === activeBuild) ?? workspace.builds[0];
  const fromWorkspace = Boolean(build);
  const document = build ? assemble(build, workspace.files) : state.document;

  const codeFiles: Array<{ name: string; code: string }> = fromWorkspace
    ? workspace.files.map((file) => ({ name: file.path, code: file.content }))
    : state.artifacts.map((item: Artifact) => ({ name: item.name, code: item.code }));
  const artifact = codeFiles[Math.min(selected, codeFiles.length - 1)];
  const previewable = fromWorkspace || state.kind === "html";

  // A fresh build should be visible without asking for it.
  useEffect(() => {
    if (previewable || state.kind === "project") setTab("preview");
  }, [previewable, state.kind, state.artifacts.length, activeBuild]);

  return (
    <section className="canvas">
      <header className="canvas-head">
        <nav className="canvas-tabs">
          <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>
            <PlayIcon /> Preview
          </button>
          <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>
            <CodeIcon /> Code{codeFiles.length ? ` ${codeFiles.length}` : ""}
          </button>
        </nav>

        {workspace.builds.length > 1 && (
          <BuildPicker
            builds={workspace.builds}
            active={build?.entry ?? null}
            onSelect={onSelectBuild}
          />
        )}

        <div className="canvas-tools">
          {tab === "preview" && (previewable || state.kind !== "empty") && (
            <>
              <div className="viewport-switch">
                {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => (
                  <button
                    key={key}
                    className={viewport === key ? "on" : ""}
                    onClick={() => setViewport(key)}
                    title={VIEWPORTS[key].label}
                  >
                    <ViewportIcon kind={key} />
                  </button>
                ))}
              </div>
              <button className="icon-btn" title="Refresh" onClick={() => setNonce(nonce + 1)}>
                <RefreshIcon />
              </button>
            </>
          )}
          <button className="icon-btn canvas-close" title="Close canvas" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="canvas-body">
        {tab === "preview" ? (
          previewable ? (
            <div className="stage-frame" data-viewport={viewport}>
              <iframe
                key={`${nonce}-${build?.entry ?? "chat"}`}
                title="Preview"
                srcDoc={document}
                sandbox="allow-scripts allow-forms allow-modals"
                style={frame.width ? { width: frame.width, height: frame.height ?? "100%" } : undefined}
              />
            </div>
          ) : state.kind === "project" ? (
            <ProjectPreview project={project} viewport={viewport} nonce={nonce} />
          ) : (
            <CanvasEmpty
              running={running}
              title={state.kind === "code" ? "Not runnable here" : "Canvas ready"}
              body={
                state.reason ??
                "Describe a page, an app or a prototype. Whatever Nomin builds runs here — desktop, tablet and mobile."
              }
            />
          )
        ) : codeFiles.length && artifact ? (
          <CodeView
            artifacts={codeFiles}
            selected={Math.min(selected, codeFiles.length - 1)}
            onSelect={setSelected}
            artifact={artifact}
          />
        ) : (
          <CanvasEmpty running={running} title="No files yet" body="Code the agent writes appears here." />
        )}
      </div>
    </section>
  );
}

/* ---------------- container ---------------- */

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Drive the container runtime for the current file set. The lifecycle — boot
 * once, tear down the previous dev server, install, start, wait for a real
 * server — lives in `lib/webcontainer.ts`; this hook only tracks its state.
 */
function useProject(state: CanvasState, nonce: number): RunState {
  const [run, setRun] = useState<RunState>({ status: "idle", log: [] });

  // Re-run only when the files actually change, not on every render.
  const signature = useMemo(
    () => state.artifacts.map((file) => `${file.name}:${simpleHash(file.code)}`).join("|"),
    [state.artifacts],
  );

  useEffect(() => {
    if (state.kind !== "project") return;

    const support = checkSupport();
    if (!support.ok) {
      setRun({ status: "unsupported", error: support.reason, log: [] });
      return;
    }

    let live = true;
    const log: string[] = [];
    setRun({ status: "checking", log: [] });

    const update = (patch: Partial<RunState>) => {
      if (live) setRun((prev) => ({ ...prev, ...patch }));
    };
    const push = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        // Strip ANSI colour codes - npm output is full of them.
        const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
        if (clean) log.push(clean);
      }
      if (live) setRun((prev) => ({ ...prev, log: log.slice(-80) }));
    };

    const handle = runProject(state.artifacts, update, push);
    return () => {
      live = false;
      void handle.then((h) => h.dispose());
    };
  }, [state.kind, signature, nonce]);

  return run;
}

function ProjectPreview({
  project,
  viewport,
  nonce,
}: {
  project: RunState;
  viewport: Viewport;
  nonce: number;
}) {
  const frame = VIEWPORTS[viewport];
  if (project.status === "ready" && project.url) {
    return (
      <div className="stage-frame" data-viewport={viewport}>
        <iframe
          key={nonce}
          title="Preview"
          src={project.url}
          style={frame.width ? { width: frame.width, height: frame.height ?? "100%" } : undefined}
        />
      </div>
    );
  }

  const labels: Record<RunState["status"], string> = {
    idle: "Waiting",
    checking: "Checking the environment",
    booting: "Booting container",
    mounting: "Mounting files",
    installing: "Installing dependencies",
    starting: project.script ? `Starting: npm run ${project.script}` : "Starting dev server",
    ready: "Ready",
    unsupported: "Container unavailable",
    failed: "Container failed",
  };

  return (
    <div className="canvas-boot">
      <div className="boot-line">
        <span className={`boot-pip ${project.status}`} />
        {labels[project.status]}
      </div>
      {project.error && <p className="boot-error">{project.error}</p>}
      {project.log.length > 0 && (
        <pre className="boot-log">{project.log.slice(-20).join("\n")}</pre>
      )}
    </div>
  );
}

/* ---------------- code view ---------------- */

/** Switch between the things this session has built. */
function BuildPicker({
  builds,
  active,
  onSelect,
}: {
  builds: Build[];
  active: string | null;
  onSelect: (entry: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = builds.find((build) => build.entry === active) ?? builds[0];

  return (
    <div className="build-picker">
      <button className="build-current" onClick={() => setOpen(!open)} type="button">
        {current?.title ?? "Builds"}
        <span className={`caret-icon${open ? " up" : ""}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="build-menu">
          {builds.map((item) => (
            <button
              key={item.entry}
              className={item.entry === active ? "on" : ""}
              onClick={() => {
                onSelect(item.entry);
                setOpen(false);
              }}
              type="button"
            >
              <span className="build-title">{item.title}</span>
              <span className="build-path">{item.entry}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CodeView({
  artifacts,
  selected,
  onSelect,
  artifact,
}: {
  artifacts: Array<{ name: string; code: string }>;
  selected: number;
  onSelect: (index: number) => void;
  artifact: { name: string; code: string };
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-view">
      <div className="code-files">
        {artifacts.map((file, i) => (
          <button key={i} className={i === selected ? "on" : ""} onClick={() => onSelect(i)}>
            {file.name}
          </button>
        ))}
      </div>
      <div className="code-pane">
        <div className="code-pane-head">
          <span>{artifact.name}</span>
          <button
            className="icon-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(artifact.code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre>
          <code>{artifact.code}</code>
        </pre>
      </div>
    </div>
  );
}

function CanvasEmpty({ title, body, running }: { title: string; body: string; running: boolean }) {
  return (
    <div className="canvas-empty">
      <div className={`canvas-empty-mark${running ? " live" : ""}`} />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/* ---------------- icons ---------------- */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M7 4.5v15l12-7.5-12-7.5Z" />
  </svg>
);

const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M9 17 4 12l5-5M15 7l5 5-5 5" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />
  </svg>
);

const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const ViewportIcon = ({ kind }: { kind: Viewport }) => {
  if (kind === "mobile") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  if (kind === "tablet") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 21h6" />
    </svg>
  );
};
