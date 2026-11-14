// The 3D ladybug, shared by the desktop pet and the web and admin pages.
// React pages use `@ladybug/mascot/react`, which wraps the renderer.

export { LadybugRenderer } from "./LadybugRenderer.ts";
export type { LadybugMode, LadybugMood, LadybugPose, LadybugViewport } from "./LadybugRenderer.ts";
export { buildLadybug } from "./ladybugModel.ts";
export type { LadybugRig } from "./ladybugModel.ts";
