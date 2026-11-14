/** A pointed leaf, stem end at the origin, pointing along +x. About 30 units long. */
const LEAF = "M0 0C6-9 20-11.5 30-3C20 5 7 6.5 0 0Z";
const VEIN = "M3-.6C11-3.4 19-4.4 26.5-3.2";

export type LeafSpec = { x: number; y: number; angle: number; size?: number };
export type FlowerSpec = { x: number; y: number; size?: number };

/**
 * A green stem with leaves, curly tendrils and the odd daisy, drawn inside an
 * <svg>. Coordinates are in the parent SVG's user space.
 */
export default function Vine({
  d,
  leaves = [],
  curls = [],
  flowers = [],
  width = 7,
}: {
  /** Path of the stem. */
  d: string;
  leaves?: LeafSpec[];
  /** Paths of thin tendrils. */
  curls?: string[];
  flowers?: FlowerSpec[];
  width?: number;
}) {
  return (
    <g className="vine">
      {curls.map((curl) => (
        <path key={curl} className="vine-curl" d={curl} />
      ))}
      <path className="vine-stem" d={d} style={{ strokeWidth: width }} />
      {leaves.map(({ x, y, angle, size = 1 }) => (
        <g key={`${x},${y}`} transform={`translate(${x} ${y}) rotate(${angle}) scale(${size})`}>
          <path className="vine-leaf" d={LEAF} />
          <path className="vine-vein" d={VEIN} />
        </g>
      ))}
      {flowers.map(({ x, y, size = 1 }) => (
        <g key={`${x},${y}`} className="vine-flower" transform={`translate(${x} ${y}) scale(${size})`}>
          {[0, 72, 144, 216, 288].map((angle) => (
            <ellipse key={angle} cx="0" cy="-6.5" rx="4" ry="6" transform={`rotate(${angle})`} />
          ))}
          <circle r="4" />
        </g>
      ))}
    </g>
  );
}
