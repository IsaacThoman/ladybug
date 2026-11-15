import { useEffect, useMemo, useRef } from "react";
import type { EyeMap } from "@ladybug/brain";
import { chartEyes } from "../brain/eye-chart";
import type { EyePicture } from "../brain/eye-chart";
import type { WallSource } from "../brain/vision";
import type { ScreenAccess } from "../ladybug-api";

/** Each eye's picture, CSS px across: two side by side fill the panel. */
const PICTURE_WIDTH = 98;
/** A visual stage's meter is full at this rate (Hz). */
const FULL_RATE = 100;
/** Facet brightness, drawn in this many shades of grey. */
const GREYS = Array.from({ length: 64 }, (_, i) => {
  const level = Math.round((i / 63) * 255);
  return `rgb(${level} ${level} ${level})`;
});

export type EyesView = {
  access: ScreenAccess;
  /** The brain's eyes, or null when it has none. */
  map: EyeMap | null;
  /** What each facet saw last, or null before the eyes have looked. */
  light: { left: Float32Array; right: Float32Array } | null;
  source: WallSource;
  /** `vision.<stage>` rates from the brain, by stage, in the order they came. */
  rates: { stage: string; rate: number }[];
};

const rateFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** "lamina" → "Lamina", "t4_t5" → "T4 t5". */
const stageLabel = (stage: string) => {
  const words = stage.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function note({ access, source }: EyesView) {
  if (source === "screen") return "It sees the screen behind it.";
  if (source === "failed") return "It sees a plain wall: the screen couldn't be captured. Turn Fly Eyes off and on again to retry.";
  if (access === "not-allowed") return "It sees a plain wall. To let it see the screen, allow Computerbug in System Settings → Privacy & Security → Screen Recording.";
  if (access === "unavailable") return "It sees a plain wall: it can't see the screen here.";
  return "Opening its eyes on the screen…";
}

function draw(canvas: HTMLCanvasElement | null, picture: EyePicture, dot: number, light: Float32Array | undefined) {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(picture.width * ratio), height = Math.round(picture.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, picture.width, picture.height);
  if (!light) return;
  const { points } = picture;
  for (let f = 0; f < light.length && f * 2 < points.length; f++) {
    const value = Math.min(1, Math.max(0, light[f] || 0));
    context.fillStyle = GREYS[Math.round(value * 63)];
    context.beginPath();
    context.arc(points[f * 2], points[f * 2 + 1], dot, 0, Math.PI * 2);
    context.fill();
  }
}

/** What the fly sees, one dot per facet, and how far it gets into the visual system. */
export default function FlyEyes({ view }: { view: EyesView }) {
  const chart = useMemo(() => (view.map ? chartEyes(view.map, PICTURE_WIDTH) : null), [view.map]);
  const rightRef = useRef<HTMLCanvasElement>(null);
  const leftRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!chart) return;
    draw(rightRef.current, chart.right, chart.dot, view.light?.right);
    draw(leftRef.current, chart.left, chart.dot, view.light?.left);
  }, [chart, view]);

  if (!chart) return <p className="brain-panel-note">This fly brain has no eyes to see with.</p>;
  const style = (picture: EyePicture) => ({ width: picture.width, height: picture.height });
  return (
    <section className="brain-panel-eyes" aria-label="What the fly sees">
      {/* As you'd see its face when it faces you: its left eye is on the right. */}
      <div className="brain-panel-eye-pictures">
        <figure>
          <canvas ref={rightRef} style={style(chart.right)} role="img" aria-label="What its right eye sees" />
          <figcaption>Right eye</figcaption>
        </figure>
        <figure>
          <canvas ref={leftRef} style={style(chart.left)} role="img" aria-label="What its left eye sees" />
          <figcaption>Left eye</figcaption>
        </figure>
      </div>
      <p className="brain-panel-note">{note(view)}</p>
      {view.rates.length > 0 && <div className="brain-panel-meters brain-panel-vision">
        {view.rates.map(({ stage, rate }) => {
          const label = stageLabel(stage);
          const value = Number.isFinite(rate) ? Math.max(0, rate) : 0;
          return (
            <div key={stage} className="brain-panel-meter">
              <span className="brain-panel-meter-label">{label}</span>
              <span
                className="brain-panel-meter-track"
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={FULL_RATE}
                aria-valuenow={Math.min(FULL_RATE, Math.round(value))}
                aria-valuetext={`${rateFormat.format(value)} spikes per second`}
              >
                <span className="brain-panel-meter-fill" style={{ left: 0, width: `${Math.min(1, value / FULL_RATE) * 100}%` }} />
              </span>
              <span className="brain-panel-meter-value">{rateFormat.format(value)} Hz</span>
            </div>
          );
        })}
      </div>}
    </section>
  );
}
