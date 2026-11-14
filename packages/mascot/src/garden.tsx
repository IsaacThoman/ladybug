import { Suspense, lazy, useId } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { LadybugMood } from "./LadybugRenderer.ts";
import type { LadybugMascotHandle } from "./LadybugMascot.tsx";
import markUrl from "./ladybug-mark.png";

// three.js is most of the weight, so the 3D bug loads after the page.
const LadybugMascot = lazy(() => import("./LadybugMascot.tsx"));

/** The 3D ladybug, rendered facing forward: brand mark, and the no-WebGL fallback. */
export function LadybugMark({ size = 32, className }: { size?: number; className?: string }) {
  return <img className={className} src={markUrl} width={size} height={size} alt="" draggable={false} />;
}

function Leaf() {
  const id = useId();
  return (
    <svg className="mascot-leaf" viewBox="0 0 340 96" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" className="stop-a" />
          <stop offset="1" className="stop-b" />
        </linearGradient>
      </defs>
      <path className="leaf-stem" d="M34 53Q16 57 7 72" />
      <path className="leaf-edge" d="M30 57C100 101 250 92 330 45C250 90 100 98 30 57Z" />
      <path fill={`url(#${id})`} d="M30 53C92 5 252 0 332 40C252 88 98 98 30 53Z" />
      <path
        className="leaf-vein"
        d="M38 53Q180 51 324 41M92 52Q112 32 138 23M92 52Q114 70 142 80M160 50Q182 30 208 21M160 50Q184 70 212 78M232 47Q252 32 272 27M232 47Q254 62 276 65"
      />
    </svg>
  );
}

type StageProps = {
  /** CSS px per model unit: about the bug's length. */
  unit: number;
  mood?: LadybugMood;
  followPointer?: boolean;
  className?: string;
  children?: ReactNode;
  ref?: Ref<LadybugMascotHandle>;
};

/** The 3D ladybug standing on a leaf, in a patch of sunlight. Decorative. */
export function MascotStage({ unit, mood, followPointer, className, children, ref }: StageProps) {
  const width = Math.round(unit * 1.8);
  const height = Math.round(unit * 1.5);
  const fallback = <LadybugMark className="mascot-fallback" />;
  return (
    <div className={className ? `mascot-stage ${className}` : "mascot-stage"} style={{ "--u": `${unit}px` } as CSSProperties}>
      <Leaf />
      <Suspense fallback={null}>
        <LadybugMascot
          ref={ref}
          className="mascot-canvas"
          width={width}
          height={height}
          unitPx={unit}
          groundPx={Math.round(unit * 0.21)}
          mood={mood}
          followPointer={followPointer}
          fallback={fallback}
        />
      </Suspense>
      {children}
    </div>
  );
}

/** Rolling hills with a few daisies, for the bottom of a page. */
export function GardenHills({ className }: { className?: string }) {
  const daisies: [number, number, number][] = [
    [148, 96, 1],
    [196, 104, 0.8],
    [690, 108, 0.9],
    [1010, 94, 1],
    [1062, 101, 0.75],
    [1330, 100, 0.9],
  ];
  return (
    <svg
      className={className ? `garden-hills ${className}` : "garden-hills"}
      viewBox="0 0 1440 140"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <path className="hill-1" d="M0 74C240 22 430 30 650 64S1090 26 1440 60V140H0Z" />
      <path className="hill-2" d="M0 100C190 66 380 68 570 94S990 72 1190 90S1370 82 1440 86V140H0Z" />
      {daisies.map(([x, y, s]) => (
        <g key={x} transform={`translate(${x} ${y}) scale(${s})`}>
          {[0, 72, 144, 216, 288].map((angle) => (
            <ellipse key={angle} className="flower" cx="0" cy="-3.4" rx="2" ry="3.2" transform={`rotate(${angle})`} />
          ))}
          <circle className="flower-heart" r="1.9" />
        </g>
      ))}
      <path className="hill-3" d="M0 122C260 102 520 106 760 120S1200 102 1440 116V140H0Z" />
    </svg>
  );
}
