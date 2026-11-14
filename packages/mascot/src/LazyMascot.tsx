import { Suspense, lazy } from "react";
import type { ComponentProps } from "react";
import { UNITS_HIGH, UNITS_WIDE } from "./aspect.ts";
import type MascotComponent from "./Mascot.tsx";

const Mascot = lazy(() => import("./Mascot.tsx"));

/**
 * The Mascot, with three.js loaded in its own chunk after the page. An empty
 * box of the same size holds its place meanwhile, so nothing shifts.
 */
export default function LazyMascot(props: ComponentProps<typeof MascotComponent>) {
  const placeholder = (
    <div
      className={props.className}
      style={{ width: "100%", aspectRatio: `${UNITS_WIDE} / ${UNITS_HIGH}`, ...props.style }}
      aria-hidden="true"
    />
  );
  return (
    <Suspense fallback={placeholder}>
      <Mascot {...props} />
    </Suspense>
  );
}
