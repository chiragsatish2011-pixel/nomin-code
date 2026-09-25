import { useEffect, useRef, useState } from "react";
import { listen, voiceSupport } from "../lib/voice.js";
import type { PreparedAttachment } from "../lib/media.js";

export type Mode = "quick" | "balanced" | "deep";

export const MicIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

const WaveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <path d="M4 12v1M8 8v8M12 5v14M16 8v8M20 12v1" />
  </svg>
);

/** What an attachment is, said plainly. */
function label(item: PreparedAttachment): string {
  if (item.problem) return "unread";
  if (item.kind === "video") return `${item.frames.length} frames`;
  if (item.kind === "image") return "image";
  if (item.kind === "audio") return item.duration ? `${Math.round(item.duration)}s audio` : "audio";
  if (item.kind === "document") {
    return item.sections ? `${item.sections} slides` : "document";
  }
  if (item.kind === "text") return "text";
  return "file";
}

const MODES: Record<Mode, { label: string; hint: string; icon: string }> = {
  quick: { label: "Quick", hint: "Short answers, least latency", icon: "⚡" },
  balanced: { label: "Balanced", hint: "The default working mode", icon: "◑" },
  deep: { label: "DeepThink", hint: "Longer reasoning budget for hard work", icon: "✳" },
};

/**
 * The composer. The aurora halo is not decoration: it is dim at rest, lifts on
 * focus, and runs while the agent is working, so the box itself reports state.
 */
export function Composer({
  draft,
  setDraft,
  submit,
  stop,
  running,
  status,
  mode,
  setMode,
  placeholder,
  attachments,
  onAttach,
  onRemoveAttachment,
  attaching,
  conversation,
  onToggleConversation,
}: {
  draft: string;
  setDraft: (value: string) => void;
  submit: () => void;
  stop: () => void;
  running: boolean;
  status: string;
  mode: Mode;
  setMode: (mode: Mode) => void;
  placeholder: string;
  attachments: PreparedAttachment[];
  onAttach: (files: FileList | null) => void;
  onRemoveAttachment: (name: string) => void;
  attaching: boolean;
  /** Hands-free mode: it listens, sends, speaks, and listens again. */
  conversation: boolean;
  onToggleConversation: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hearing, setHearing] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const micRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const support = useRef(voiceSupport()).current;

  // Dictation fills the box; it never sends on its own, because a stray noise
  // should not start a build.
  const toggleMic = () => {
    if (hearing) {
      micRef.current?.stop();
      micRef.current = null;
      setHearing(false);
      return;
    }
    const base = draft.trim();
    const handle = listen({
      onPartial: (text) => setDraft(base ? `${base} ${text}` : text),
      onFinal: (text) => {
        setDraft(base ? `${base} ${text}` : text);
        setHearing(false);
        micRef.current = null;
      },
      onError: (message) => {
        setVoiceNote(message);
        setHearing(false);
        micRef.current = null;
        window.setTimeout(() => setVoiceNote(null), 4000);
      },
    });
    if (handle) {
      micRef.current = handle;
      setHearing(true);
    }
  };

  useEffect(() => () => micRef.current?.abort(), []);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Grow with the draft, up to a limit, then scroll.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  }, [draft]);

  return (
    <div className={`composer-shell${running ? " running" : ""}`}>
      <span className="composer-halo" aria-hidden="true" />
      <div className="composer">
        {(attachments.length > 0 || attaching) && (
          <ul className="attachments">
            {attachments.map((item) => (
              <li key={item.name} className={item.problem ? "attachment problem" : "attachment"}>
                <span className="attachment-kind">{label(item)}</span>
                <span className="attachment-name">{item.name}</span>
                <button onClick={() => onRemoveAttachment(item.name)} title="Remove" type="button">
                  ✕
                </button>
              </li>
            ))}
            {attaching && <li className="attachment reading">Reading…</li>}
          </ul>
        )}

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            onAttach(event.target.files);
            event.target.value = "";
          }}
        />

        <textarea
          ref={areaRef}
          value={draft}
          placeholder={placeholder}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        {voiceNote && <p className="voice-note">{voiceNote}</p>}

        <div className="composer-bar">
          {support.listening && (
            <button
              className={`round-btn mic${hearing ? " hearing" : ""}`}
              title={hearing ? "Stop listening" : "Dictate"}
              type="button"
              onClick={toggleMic}
            >
              <MicIcon />
            </button>
          )}

          {support.listening && support.speaking && (
            <button
              className={`round-btn talk${conversation ? " on" : ""}`}
              title={conversation ? "Leave conversation mode" : "Talk with Nomin"}
              type="button"
              onClick={onToggleConversation}
            >
              <WaveIcon />
            </button>
          )}

          <button
            className="round-btn"
            title="Attach an image, a video, audio or a file"
            type="button"
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>

          <div className="mode-picker" ref={menuRef}>
            <button className="mode-btn" onClick={() => setOpen(!open)} type="button">
              <span className="mode-icon">{MODES[mode].icon}</span>
              {MODES[mode].label}
              <span className={`caret-icon${open ? " up" : ""}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {open && (
              <div className="mode-menu" role="menu">
                {(Object.keys(MODES) as Mode[]).map((key) => (
                  <button
                    key={key}
                    className={key === mode ? "on" : ""}
                    onClick={() => {
                      setMode(key);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <span className="mode-icon">{MODES[key].icon}</span>
                    <span className="mode-text">
                      {MODES[key].label}
                      <em>{MODES[key].hint}</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="composer-status">{running ? status : ""}</span>

          {running ? (
            <button className="stop-btn" onClick={stop} title="Stop" type="button">
              <span className="stop-square" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
              title="Send"
              type="button"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
