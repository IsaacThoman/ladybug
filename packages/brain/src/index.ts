// The fly brain: a spiking simulation of the male fruit fly's central nervous
// system, wired from the Janelia FlyEM male CNS connectome (CC-BY).
// Browser-safe; the Node-only packer and file loader are src/pack.ts and
// src/node.ts.

export { createBrain } from "./runtime.ts";
export { RESTING_SENSES } from "./types.ts";
export type { Brain, BrainCommand, BrainRequest, BrainResponse, BrainSenses, BrainState, BrainStats, Eye, EyeMap } from "./types.ts";
export {
  CATEGORY_COLUMNS,
  CATEGORY_NAMES,
  CONNECTOME_MAGIC,
  CONNECTOME_VERSION,
  ConnectomeFormatError,
  FLYEM_MALE_CNS,
  loadConnectome,
  writeConnectome,
} from "./format.ts";
export type { CategoryColumn, CategoryName, Connectome, ConnectomeData, ConnectomeHeader, ConnectomeSource, NeuronQuery, SectionInfo } from "./format.ts";
export { ACCEPTANCE, EYE_GEOMETRY, buildEyes, facetDirection } from "./eyes.ts";
export type { EyeCells, Eyes, Side } from "./eyes.ts";
export { COLUMN_KINDS, EYE_COLUMNS } from "./eye-columns.ts";
export type { EyeColumn } from "./eye-columns.ts";
export { RETINA, Retina, VISION_STAGES, stageName } from "./vision.ts";
export type { RetinaParameters } from "./vision.ts";
export { PoissonInput, RatedPoissonInput, Simulation, gainByTransmitter, inputSeed, mulberry32 } from "./sim.ts";
export type { Network, SimulationOptions, SimulationStats } from "./sim.ts";
