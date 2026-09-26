/**
 * The Nomin mark.
 *
 * The N, cut into four pieces: a back-leaning left stem, the bold diagonal,
 * and the right stem split by an angled cut. The slivers between them are the
 * whole character of it, so they are held open rather than closed up at small
 * sizes — the corners are rounded by stroking each piece in its own fill,
 * which keeps the gaps honest at 24px and at 240.
 *
 * It draws in `currentColor` by default so a bar, a button or a footer can
 * colour it by setting text colour, and takes the aurora when it is the
 * subject rather than a label.
 */

/** The four pieces, in a 200×150 box. */
const PIECES = [
  "M42 54 L64 54 L44 142 L21 142 Z",
  "M58 8 L96 8 L142 142 L103 142 Z",
  "M150 8 L192 8 L187 30 L141 51 Z",
  "M141 59 L132 100 L151 142 L170 142 L187 38 Z",
];

const RATIO = 200 / 150;

export function Mark({
  size = 28,
  busy = false,
  aurora = false,
}: {
  /** Height in pixels. The width follows the mark's own proportions. */
  size?: number;
  busy?: boolean;
  /** Draw in the brand gradient rather than the surrounding text colour. */
  aurora?: boolean;
}) {
  const id = `mark-${size}${aurora ? "-a" : ""}`;
  const paint = aurora ? `url(#${id}-g)` : "currentColor";

  return (
    <svg
      width={Math.round(size * RATIO)}
      height={size}
      viewBox="0 0 200 150"
      fill="none"
      aria-hidden="true"
      className={busy ? "mark busy" : "mark"}
    >
      {aurora && (
        <defs>
          <linearGradient id={`${id}-g`} x1="20" y1="8" x2="192" y2="142" gradientUnits="userSpaceOnUse">
            <stop stopColor="#a07dff" />
            <stop offset="0.55" stopColor="#7132f5" />
            <stop offset="1" stopColor="#2ed3c6" />
          </linearGradient>
        </defs>
      )}
      <g fill={paint} stroke={paint} strokeWidth="3" strokeLinejoin="round">
        {PIECES.map((piece) => (
          <path key={piece} d={piece} />
        ))}
      </g>
    </svg>
  );
}
