/**
 * The ladybug's garden: rolling hills with a few daisies, and soft clouds.
 * Decorative SVG, coloured by the host page's CSS through these classes:
 * .hill-back, .hill-mid, .hill-front, .tuft, .petal, .heart and .cloud.
 */

const W = 2400;
const H = 200;
const STEP = 24;

type Wave = [amplitude: number, period: number, phase: number];
type Layer = { base: number; waves: Wave[] };

const LAYERS = {
  back: { base: 64, waves: [[20, 1500, 0.4], [8, 520, 1.9]] },
  mid: { base: 96, waves: [[16, 1200, 2.6], [7, 430, 0.3]] },
  front: { base: 128, waves: [[12, 980, 4.1], [5, 360, 2.2]] },
} satisfies Record<string, Layer>;

const crest = ({ base, waves }: Layer, x: number) =>
  waves.reduce((y, [amplitude, period, phase]) => y + amplitude * Math.sin((x / period) * Math.PI * 2 + phase), base);

function hillPath(layer: Layer) {
  let d = `M0 ${H}`;
  for (let x = 0; x <= W; x += STEP) d += `L${x} ${crest(layer, x).toFixed(1)}`;
  return `${d}L${W} ${H}Z`;
}

/** Little clumps of blades along the front crest, so it reads as grass. */
function tuftsPath() {
  let d = "";
  for (let x = 30; x < W; x += 74 + ((x * 7) % 40)) {
    const y = crest(LAYERS.front, x) + 3;
    for (const [dx, h, lean] of [
      [-6, 11, -4],
      [0, 15, 1],
      [6, 10, 4],
    ]) {
      const bx = x + dx;
      d += `M${bx - 2.2} ${y}Q${bx + lean * 0.4} ${y - h * 0.6} ${bx + lean} ${y - h}Q${bx + lean * 0.2} ${y - h * 0.5} ${bx + 2.2} ${y}Z`;
    }
  }
  return d;
}

/** Daisies on the front hill, bunched toward the middle so phones still see some. */
const DAISIES = [430, 610, 980, 1110, 1180, 1330, 1470, 1520, 1790, 1960].map((x, i) => ({
  x,
  y: crest(LAYERS.front, x) + 18 + ((i * 13) % 40),
  r: 4.2 + ((i * 5) % 3),
}));

const PATHS = {
  back: hillPath(LAYERS.back),
  mid: hillPath(LAYERS.mid),
  front: hillPath(LAYERS.front),
  tufts: tuftsPath(),
};

export function Hills({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <path className="hill-back" d={PATHS.back} />
      <path className="hill-mid" d={PATHS.mid} />
      <path className="hill-front tuft" d={PATHS.tufts} />
      <path className="hill-front" d={PATHS.front} />
      {DAISIES.map(({ x, y, r }) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          {[0, 72, 144, 216, 288].map((angle) => (
            <ellipse
              key={angle}
              className="petal"
              cx={0}
              cy={-r * 0.9}
              rx={r * 0.48}
              ry={r * 0.85}
              transform={`rotate(${angle})`}
            />
          ))}
          <circle className="heart" r={r * 0.45} />
        </g>
      ))}
    </svg>
  );
}

/** A cloud of overlapping puffs, drawn as one group so the overlaps don't show. */
export function Cloud({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 220 90" aria-hidden="true" focusable="false">
      <g className="cloud">
        <circle cx="62" cy="58" r="26" />
        <circle cx="100" cy="40" r="34" />
        <circle cx="144" cy="52" r="27" />
        <circle cx="176" cy="66" r="18" />
        <rect x="36" y="58" width="158" height="26" rx="13" />
      </g>
    </svg>
  );
}
