/**
 * The Nomin mark.
 *
 * The N, cut into four pieces: a back-leaning left stem, the bold diagonal,
 * the top-right arm and the stem below it, with a wedge of space opening
 * upward between the diagonal and that stem. The slivers between the pieces
 * are the whole character of it. The corners are rounded by stroking each
 * piece in its own fill, which is what the artwork does and what keeps the
 * shapes from going brittle at 24px.
 *
 * It draws in `currentColor` by default so a bar, a button or a footer can
 * colour it by setting text colour, and takes the aurora when it is the
 * subject rather than a label.
 */

/**
 * The four pieces, traced from the artwork at its own scale. The box carries
 * the tracing's own origin rather than a normalised one, so every number here
 * can still be checked against the source it came from.
 */
const PIECES = [
  "M408 428 L538 428 L421 938 L250 938 Z",
  "M497 271 L690 271 L918 938 L752 938 Z",
  "M990 271 L1192 271 L1160 392 L948 452 Z",
  "M955 458 L1145 425 L1008 938 L925 938 Z",
];

/** Includes the rounding stroke, so the box is what the eye sees. */
const VIEW_BOX = "244 265 954 679";
const RATIO = 954 / 679;

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
      viewBox={VIEW_BOX}
      fill="none"
      aria-hidden="true"
      className={busy ? "mark busy" : "mark"}
    >
      {aurora && (
        <defs>
          <linearGradient id={`${id}-g`} x1="250" y1="271" x2="1192" y2="938" gradientUnits="userSpaceOnUse">
            <stop stopColor="#a07dff" />
            <stop offset="0.55" stopColor="#7132f5" />
            <stop offset="1" stopColor="#2ed3c6" />
          </linearGradient>
        </defs>
      )}
      <g fill={paint} stroke={paint} strokeWidth="12" strokeLinejoin="round">
        {PIECES.map((piece) => (
          <path key={piece} d={piece} />
        ))}
      </g>
    </svg>
  );
}
