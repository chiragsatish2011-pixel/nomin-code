# Nomin Code

An autonomous engineering workspace. One app: the agent, the model layer and the
live work tree are parts of the same thing, not separate products.

**Trion 1.5** is the model. Nect 1.3 and Fret 5 are declared in the registry as
future models and fail loudly if selected; nothing pretends they work.

The backend behind Trion 1.5 is configuration, not product: it appears in
`src/model/registry.ts` and `.env` only. It never reaches the UI, the work
tree, an error message or a log line — provider failures are re-worded in
Nomin's own voice before they leave the server.

```bash
npm install
npm run dev          # http://localhost:5180
```

The key lives in `.env` at the repo root (git-ignored):

```
NVIDIA_API_KEY=nvapi-…
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

It is read by the dev server only. It never enters the client bundle, the UI,
the work tree or any log line.

## Layout

```
src/
├── App.tsx              workspace shell — task bar, rail, stage
├── components/
│   ├── Composer.tsx     the prompt box: aurora halo, modes, send
│   ├── ParticleOrb.tsx  the thinking orb — animated SVG particle sphere
│   ├── ThinkingBlock.tsx thinking header + the work tree growing out of it
│   ├── Pipeline.tsx     THINK → PLAN → BUILD → TEST → VERIFY, from real events
│   ├── QuestionCard.tsx selectable clarification questions
│   ├── Canvas.tsx       Preview / Code, WebContainer, device views
│   ├── Markdown.tsx     small safe markdown renderer
│   └── Mark.tsx         the Nomin mark
├── lib/useAgent.ts      SSE client — splits the stream into answer + events
├── model/               the model layer
│   ├── registry.ts      Trion 1.5 / Nect 1.3 / Fret 5 + the supervisor seat
│   ├── prompt.ts        the frozen prefix and the work tier
│   ├── nvidia.ts        provider: streaming, tool calls, retry, cooldown
│   ├── supervisor.ts    the manager AI — did the work actually happen?
│   ├── agent.ts         one turn → answer + events + verdict
│   └── types.ts         the provider-neutral interface
└── work-tree/           the live animated SVG tree
    ├── events.ts        agent event vocabulary + event → tree rules
    ├── model.ts         events → node graph
    ├── renderer.ts      eased layout, self-drawing branches, aurora
    └── scribble.ts      the hand-drawn head from the original sketch
```

`vite.config.ts` carries the `/api/chat` endpoint: it runs `runTurn` on the
server and streams frames to the browser as SSE.

## How a turn works

1. The composer posts the history and the mode to `/api/chat`.
2. `runTurn` opens a stream to Trion 1.5 and translates it into frames:
   `text` for the answer, `tree` for the work tree, `usage`, `error`, `end`.
3. The thinking block shows the orb and the tree; the answer renders below it.
4. The pipeline lights the phases the agent actually entered.

The model's private reasoning channel (`reasoning_content`) is consumed as a
*signal only* — it drives the "thinking" state and is never displayed.

## The prompt layer

Latency on a reasoning model comes from the prefix it re-reads and the thinking
budget it is given. Both are managed:

- **A frozen prefix.** `CORE_PROMPT` (~95 tokens) is a constant — never
  templated, never re-ordered, always message 0 — so NIM's KV-cache reuse can
  skip re-processing it. Mutating it per turn would silently destroy that cache.
- **A work tier.** The engineering rules (~85 tokens) are appended *after* the
  history, and only when the request looks like engineering work. A greeting
  never pays for the build loop.
- **An adaptive budget.** In Balanced mode a conversational turn gets a 900
  token ceiling so the model barely reasons; build/fix/debug requests get the
  full budget. Quick and DeepThink are honoured exactly as chosen.

## Clarification

For substantial work the agent may ask before planning. It emits a fenced
`nomin-questions` block; the UI lifts it out of the prose and renders it as a
card — numbered options, number-key selection, "Other" for free text, and Skip,
which tells the agent to use its judgement rather than inventing an answer.

## The supervisor

A separate manager reviews every turn and answers one question: *was the work
actually delivered?*

- **Evidence first, free.** An empty answer, an unresolved test failure, a claim
  of "all tests pass" with no passing event behind it — all detectable without a
  model, on every turn.
- **A model only when needed.** If a second key is configured
  (`NOMIN_SUPERVISOR_API_KEY`), a smaller model reviews a compact digest — not
  the transcript — and only when the turn did real work. It runs *after* the
  answer is already on screen, so it adds no latency, and it sits on its own
  credentials so review traffic never eats the worker's rate limit.
- Verdicts are `verified`, `unverified`, `concerns` or `failed`, shown as a chip
  under the answer. "Unverified" is used honestly: nothing is called verified
  without evidence.

## The canvas

Closed by default. It opens when you ask for it, or by itself when the agent
produces something runnable. A single page renders in a sandboxed iframe; a
multi-file project boots in a WebContainer (`npm install`, dev server) with
desktop, tablet and mobile views and a refresh control. Cross-origin isolation
is set by the dev server; when a browser cannot provide it, the panel says so
rather than pretending to run.

## The doctor team (self-healing)

Six specialists that run only when Nomin itself is broken, and only on the
manager's command. They are stronger than the manager by design: the manager
notices and describes, the doctors diagnose and repair.

| Doctor | Role | Runs on |
|---|---|---|
| D1 | Diagnosis — traces the fault | 550B Ultra |
| D2 | Repair — writes the fix | 120B Super |
| D3 | Verification — proves it holds | 120B Super |
| D4 | Regression — hunts knock-on damage | 120B Super |
| D5 | Surface — checks what the user sees | 30B omni (vision) |
| D6 | Record — writes down what changed | 30B omni |

Each holds **its own credential** (`NOMIN_DOCTOR_1..6_API_KEY`), so six repairs
run at once without touching the worker's or the manager's rate budget.

### CRPM

`src/model/crpm.ts` is the scheduler that makes six agents behave like one
system with six hands:

- **One lane per credential.** Lanes are keys, not models. Calls inside a lane
  are serialised; lanes run in parallel.
- **Spacing, not bursting.** Each lane holds calls to an interval derived from
  its budget, so a burst is smoothed instead of rejected.
- **A 429 is a lane event.** The throttled lane backs off; the other five keep
  working, and queued work survives the cooldown rather than being dropped.
- **Work is split before it is sent** (`splitWork`), so a doctor asks for
  several completions it can finish instead of one that gets truncated.

### Evidence baseline

`src/model/evidence.ts` records what "green" looks like — every watched file
with a content fingerprint, plus whether the project's own typecheck passed —
and refreshes it every 24 hours. The manager diffs against it to tell "this is
broken" from "this was always like that".

It will not overwrite a green baseline with a broken one: recording a failing
state as normal is how a self-healing system learns to ignore its own illness.

## Tools, and the gate in front of them

A turn is in one of two modes, enforced in code rather than asked for in a
prompt:

**Planning.** No tools are sent. Trion can think, ask and propose a plan — it
cannot touch the workspace however it is asked. The plan arrives as a card
with Approve or Request changes.

**Execution.** Approval hands the plan back with the request, and only then do
the tools travel with it. The plan is passed explicitly, not read from state,
so approval cannot be lost to a re-render.

### The workspace

Each session owns a real directory (`.nomin/workspaces/<id>`). Four tools act
on it — `list_files`, `read_file`, `write_file`, `run_command` — and three
rules make that safe to hand to a model:

- **Every path is resolved and checked.** `..`, absolute paths and symlinks are
  rejected before anything is opened.
- **Commands are an allowlist** (`npm`, `npx`, `node`, `tsc`, `vite`), and any
  argument carrying shell punctuation is refused — Windows needs a shell for
  `.cmd` shims, so the arguments are guarded instead.
- **Credentials never reach a child process.** Verified: a script the model
  writes and runs sees `{"leaked":[]}`.

There is no delete and no rename. Destroying work is a decision for a person.

## Sessions that survive a reload

Every session is written to IndexedDB — conversation, work-tree events, the
approved plan and its status — and restored on open. The sidebar lists real
sessions and switches between them. Files live on disk, so a reload resumes
against the same workspace rather than starting again.

## Images and video

Trion reads text, not pixels. So anything visual goes through a second,
multimodal model whose only job is to turn frames into words; the description
reaches Trion, the image never does. Replies say so ("based on the description
provided") rather than pretending the model looked.

**Images** are downscaled to 1024px and read in one call.

**Video** is broken into frames with `<video>` and a canvas — no ffmpeg, no
native dependency, and the file never leaves the machine; only the sampled
frames do. The clip is sampled by length (4 frames under 5s, up to 12 over two
minutes), read **two frames per call** so the model sees motion, then the notes
are drawn together into one account of what happens over time.

Every vision call is booked through CRPM on its own lane and its own
credential, so reading a long video never starves the worker or the manager.

Two things worth knowing:

- Recorded WebM files routinely carry a wrong or infinite duration. Nomin seeks
  past the end to force the browser to resolve the real length — without that,
  a three-second clip gets sampled as if it were one second.
- Nothing is stored. Frames are built in memory and sent straight to the vision
  model, so there is no upload directory to sweep and nothing to leak later.

## Rate limits

429s and the upstream 500/502/503/504 (which appear under load) are treated
the same way: read `Retry-After` when present, otherwise exponential
backoff with jitter, capped by the model's retry policy. The turn is not
restarted. The UI parks the branch in the waiting state, counts the cooldown
down in place, and resumes the same step when it clears.

## Modes

| Mode | Budget | For |
|---|---|---|
| Quick | 1024 tokens, temp 0.1 | Short answers |
| Balanced | 4096 tokens, temp 0.2 | The default |
| DeepThink | 8192 tokens, temp 0.35 | Hard, multi-step work |

## Theme

Resolved in priority order: the user's own choice (persisted in
`localStorage`), then the operating system's preference, then light. An inline
script in `index.html` applies it before first paint, so a hard refresh never
flashes the wrong theme, and the OS is only followed until the user picks for
themselves.

## Design

Layout and pacing from `DESIGN-claude.md`; colour, type and radii from
`DESIGN-kraken.md` — Kraken Purple `#7132f5`, 12px radii, Kraken-Brand /
Kraken-Product. The aurora (purple → cyan) is reserved for work that is
genuinely live: the active branch, the composer halo while streaming, the
thinking label.

## Not built yet

Workspace tools (read, edit, run, test against a real project), plan approval as
a first-class gate, and checkpointed task state that survives a restart are
designed for but not implemented. Nothing in the UI claims they are.
