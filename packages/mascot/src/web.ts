// What the web pages and admin UI use: the garden, and the mascot with
// three.js split into its own chunk. Nothing here imports three.js up front.

export { Cloud, Hills } from "./Garden.tsx";
export { default as Mascot } from "./LazyMascot.tsx";
export { MASCOT_ASPECT } from "./aspect.ts";
export type { LadybugMood } from "./LadybugRenderer.ts";
export type { MascotHandle, MascotLook } from "./Mascot.tsx";
