import type { PointerEvent as ReactPointerEvent, Ref } from "react";
import { BERRY_PX, BERRY_RADIUS, FOOD_SIZE } from "../food";

/** Half the drawing's width, in its own units (px at BERRY_PX). */
const HALF = BERRY_PX / 2;

/**
 * The berry the bug is fed. The pet's animation loop moves it and takes the
 * bites out of it with `drawBerry`; nothing here re-renders while it's eaten.
 */
export default function Berry({ ref, ...handlers }: {
  ref: Ref<HTMLDivElement>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  /** Everything left of a scalloped edge; `drawBerry` slides it across. */
  const bitten = (
    <>
      <rect x={-60} y={-20} width={60} height={40} fill="black" />
      <circle cx={0} cy={-7.5} r={4.6} fill="black" />
      <circle cx={1.6} cy={0.5} r={5.2} fill="black" />
      <circle cx={0} cy={8} r={4.4} fill="black" />
    </>
  );
  return (
    <div ref={ref} className="pet-food" aria-hidden data-overlay-interactive style={{ width: FOOD_SIZE, height: FOOD_SIZE }} {...handlers}>
      <svg viewBox={`${-HALF} ${-HALF} ${HALF * 2} ${HALF * 2}`} width={BERRY_PX} height={BERRY_PX}>
        <defs>
          <radialGradient id="berry-skin" cx="38%" cy="30%" r="75%">
            <stop offset="0" stopColor="#8ea2ee" />
            <stop offset="0.45" stopColor="#4a5cc0" />
            <stop offset="1" stopColor="#262f78" />
          </radialGradient>
          <mask id="berry-skin-bite" maskUnits="userSpaceOnUse" x={-HALF} y={-HALF} width={HALF * 2} height={HALF * 2 + 2}>
            <rect x={-HALF} y={-HALF} width={HALF * 2} height={HALF * 2 + 2} fill="white" />
            <g data-bite="skin">{bitten}</g>
          </mask>
          <mask id="berry-flesh-bite" maskUnits="userSpaceOnUse" x={-HALF} y={-HALF} width={HALF * 2} height={HALF * 2 + 2}>
            <rect x={-HALF} y={-HALF} width={HALF * 2} height={HALF * 2 + 2} fill="white" />
            <g data-bite="flesh">{bitten}</g>
          </mask>
        </defs>
        <g data-berry>
          {/* The shadow goes as the berry does. */}
          <ellipse className="pet-food-shadow" cx={0} cy={10.6} rx={9} ry={1.4} mask="url(#berry-skin-bite)" />
          <circle cx={0} cy={0.5} r={9.3} fill="#d7c9ec" mask="url(#berry-flesh-bite)" />
          <g mask="url(#berry-skin-bite)">
            <circle cx={0} cy={0.5} r={BERRY_RADIUS} fill="url(#berry-skin)" />
            {/* The crown at the top, and the bloom on the skin. */}
            <path d="M-3.2 -7.4 L-1.6 -8.6 L0 -7.3 L1.6 -8.6 L3.2 -7.4 L2 -5.9 L-2 -5.9 Z" fill="#1d2460" />
            <ellipse cx={-3.6} cy={-2.6} rx={2.6} ry={1.7} fill="#fff" opacity={0.28} transform="rotate(-28 -3.6 -2.6)" />
          </g>
        </g>
      </svg>
    </div>
  );
}
