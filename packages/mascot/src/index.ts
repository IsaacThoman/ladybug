// The ladybug, in 3D: the desktop pet's renderer and model, plus React
// pieces for the web pages and admin UI: the bug on its leaf, and its garden.
// Pages should import from "@ladybug/mascot/web" instead, which loads three.js
// lazily.

export { LadybugRenderer } from "./LadybugRenderer.ts";
export type {
  LadybugMode,
  LadybugMood,
  LadybugOptions,
  LadybugPose,
  LadybugViewport,
} from "./LadybugRenderer.ts";
export { buildLadybug } from "./ladybugModel.ts";
export type { LadybugRig } from "./ladybugModel.ts";
export { MASCOT_ASPECT } from "./aspect.ts";
export { default as Mascot } from "./Mascot.tsx";
export type { MascotHandle, MascotLook } from "./Mascot.tsx";
export { Cloud, Hills } from "./Garden.tsx";
