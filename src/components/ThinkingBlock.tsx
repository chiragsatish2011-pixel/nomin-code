import { useEffect, useRef, useState } from "react";
import { WorkTreeView } from "@nomin/work-tree/react";
import { krakenAurora, krakenDark, type AgentEvent } from "@nomin/work-tree";
import { ParticleOrb } from "./ParticleOrb.js";
import { currentPhase } from "./Pipeline.js";

/**
 * The thinking block: the orb, the status line, and the work tree growing
 * straight out of it. One connected element — the agent's activity is part of
 * its answer, not a panel somewhere else.
 *
 * The model's private reasoning is never shown; only what it did.
 */
export function ThinkingBlock({
  events,
  running,
  theme,
  status,
}: {
  events: AgentEvent[];
  running: boolean;
  theme: "light" | "dark";
  status: string;
}) {
  const [open, setOpen] = useState(true);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const settled = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      settled.current ??= Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
      return;
    }
    settled.current = null;
    const timer = window.setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      500,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);

  if (!events.length) return null;

  const seconds = running ? elapsed : (settled.current ?? elapsed);
  const steps = events.filter((event) => event.type.endsWith(".started")).length;
  const phase = currentPhase(events);

  return (
    <section className={`thinking${open ? " open" : ""}${running ? " live" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)} type="button">
        <ParticleOrb size={running ? 56 : 44} count={running ? 520 : 300} active={running} />
        <span className="thinking-copy">
          <span className="thinking-label">{running ? status : `Thought for ${seconds}s`}</span>
          <span className="thinking-meta">
            {phase ? `${phase.toLowerCase()} · ` : ""}
            {steps} step{steps === 1 ? "" : "s"} · {seconds}s
          </span>
        </span>
      </button>

      {open && (
        <div className="thinking-tree">
          <WorkTreeView
            events={events}
            rootless
            theme={theme === "dark" ? krakenDark : krakenAurora}
          />
        </div>
      )}
    </section>
  );
}
