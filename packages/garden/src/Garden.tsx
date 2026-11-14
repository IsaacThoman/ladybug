import Vine from "./Vine.tsx";

/** left %, top %, size px, delay s */
const SPARKLES = [
  [7, 21, 4, 0],
  [13, 63, 3, 1.2],
  [22, 8, 3, 2.1],
  [30, 39, 5, 0.6],
  [43, 13, 3, 1.7],
  [51, 74, 4, 2.6],
  [60, 26, 3, 0.9],
  [67, 54, 5, 3.1],
  [77, 10, 4, 1.4],
  [84, 67, 3, 2.3],
  [90, 33, 4, 0.3],
  [95, 83, 3, 1.9],
  [36, 90, 3, 2.8],
  [4, 86, 4, 1.1],
  [56, 45, 3, 3.4],
  [73, 92, 4, 0.7],
] as const;

/**
 * The sky behind every page: a soft blue gradient with light blooms, twinkling
 * sparkles (fireflies at night) and vines curling in from the edges. Fixed to
 * the viewport, behind the content.
 */
export default function Garden({ vines = true }: { vines?: boolean }) {
  return (
    <div className="garden" aria-hidden="true">
      {SPARKLES.map(([left, top, size, delay]) => (
        <span
          key={`${left},${top}`}
          className="sparkle"
          style={{ left: `${left}%`, top: `${top}%`, width: size, height: size, animationDelay: `${delay}s` }}
        />
      ))}
      {vines && (
        <>
          <svg className="garden-vine garden-vine-left" viewBox="0 0 260 640">
            <Vine
              d="M-12 96C110 74 214 190 206 380 200 500 150 580 46 628"
              leaves={[
                { x: 70, y: 84, angle: -40, size: 1.1 },
                { x: 150, y: 140, angle: 30, size: 1.25 },
                { x: 200, y: 268, angle: -70, size: 1 },
                { x: 204, y: 400, angle: 20, size: 1.2 },
                { x: 168, y: 524, angle: 150, size: 1.1 },
                { x: 100, y: 600, angle: 200, size: 0.9 },
              ]}
              curls={["M126 112c10-26 40-30 46-10 4 14-12 20-18 10", "M196 470c26 2 34 28 18 38-10 6-18-6-10-12"]}
              flowers={[{ x: 211, y: 330, size: 0.9 }]}
            />
            <Vine d="M-12 560C40 520 104 532 120 600" width={5} leaves={[{ x: 52, y: 534, angle: -60, size: 0.85 }]} />
          </svg>
          <svg className="garden-vine garden-vine-right" viewBox="0 0 320 260">
            <Vine
              d="M340 236C250 232 182 192 172 118 166 66 206 34 250 48"
              leaves={[
                { x: 280, y: 228, angle: -150, size: 1.1 },
                { x: 196, y: 196, angle: 120, size: 1.15 },
                { x: 170, y: 120, angle: -120, size: 1 },
                { x: 214, y: 46, angle: -20, size: 0.9 },
              ]}
              curls={["M252 48c20 6 24 30 6 34-12 2-14-12-4-14"]}
              flowers={[{ x: 236, y: 224, size: 0.8 }]}
            />
          </svg>
        </>
      )}
    </div>
  );
}
