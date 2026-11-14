import type { Ref } from "react";
import { Ladybug, SpeechBubble, Vine } from "@ladybug/garden";
import type { BubbleTone, LadybugHandle, LadybugMood } from "@ladybug/garden";
import { useMediaQuery } from "../useMediaQuery.ts";

/** The scene is drawn in a 480 × 400 box and scaled as a whole. */
const W = 480;
const H = 400;
/** The flat stretch of branch the ladybug strolls along. */
const BRANCH_Y = 300;
const BRANCH_STROKE = 9;
const HOME_X = 255;
const BUG_SIZE = 150;

type Props = { mood: LadybugMood; say: string; tone: BubbleTone; ref?: Ref<LadybugHandle> };

/** A vine with a branch for the ladybug to walk along, on the home page. */
export default function HeroScene({ mood, say, tone, ref }: Props) {
  const small = useMediaQuery("(max-width: 900px)");
  const tiny = useMediaQuery("(max-width: 420px)");
  const scale = tiny ? 0.62 : small ? 0.72 : 1;
  const size = Math.round(BUG_SIZE * scale);
  // Place the bug's canvas so its ground line sits on top of the branch.
  const left = HOME_X * scale - (size * 1.8) / 2;
  const bottom = (H - BRANCH_Y + BRANCH_STROKE / 2) * scale - Math.round(size * 0.14);

  return (
    <div className="hero-scene" style={{ width: W * scale, height: H * scale }}>
      <svg className="hero-vines" viewBox={`0 0 ${W} ${H}`} width={W * scale} height={H * scale} aria-hidden="true">
        <Vine
          d="M70 314C14 236 34 120 142 72 202 46 262 52 304 84"
          width={6}
          leaves={[
            { x: 46, y: 214, angle: -150, size: 1.2 },
            { x: 82, y: 118, angle: -60, size: 1.1 },
            { x: 168, y: 62, angle: -80, size: 1 },
            { x: 252, y: 58, angle: 10, size: 1.15 },
          ]}
          curls={["M304 84c22 18 14 48-8 42-14-4-10-22 2-18"]}
          flowers={[{ x: 116, y: 86, size: 1.1 }]}
        />
        <Vine
          d={`M-16 404C24 364 40 322 96 308 140 ${BRANCH_Y} 160 ${BRANCH_Y} 190 ${BRANCH_Y}H330C376 ${BRANCH_Y} 418 296 448 278`}
          width={BRANCH_STROKE}
          leaves={[
            { x: 30, y: 368, angle: -40, size: 1.2 },
            { x: 120, y: 304, angle: 115, size: 1.15 },
            { x: 205, y: 304, angle: 95, size: 1 },
            { x: 300, y: 304, angle: 80, size: 1.1 },
            { x: 384, y: 296, angle: 65, size: 1.2 },
            { x: 150, y: 300, angle: -70, size: 0.95 },
            { x: 372, y: 298, angle: -115, size: 0.9 },
          ]}
          curls={["M448 278c22-14 22-44 0-46-14 0-16 18-4 20"]}
          flowers={[
            { x: 448, y: 278, size: 1.3 },
            { x: 92, y: 310, size: 0.9 },
          ]}
        />
      </svg>
      <Ladybug ref={ref} className="hero-bug" style={{ left, bottom }} mood={mood} size={size} wander={small ? 40 : 70}>
        <SpeechBubble text={say} tone={tone} />
      </Ladybug>
    </div>
  );
}
