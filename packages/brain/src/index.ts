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
export { PoissonInput, Simulation, gainByTransmitter, inputSeed, mulberry32 } from "./sim.ts";
export type { Network, SimulationOptions, SimulationStats } from "./sim.ts";
