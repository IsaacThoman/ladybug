# @ladybug/brain

A spiking simulation of the male fruit fly's whole central nervous system, about 167,000 neurons wired as they are in the real animal, that drives the desktop pet. `src/types.ts` is the contract with the pet; this package turns senses into firing of the fly's sensory neurons and reads its descending and motor neurons back out as commands.

## Data

The wiring is the [FlyEM male CNS](https://male-cns.janelia.org/) connectome from Janelia Research Campus, published under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Anything that ships the packed file, or shows behaviour derived from it, should credit "FlyEM male CNS connectome, Janelia Research Campus (CC-BY 4.0)". The packed file records the dataset, license and URL in its header.

It is not in git. Export the neuron and connection tables from Codex (`neurons.csv` and `connections_princeton.csv`; either may be gzipped, whatever the file name says) and pack them:

```sh
npm run brain:pack -- --neurons neurons.csv --connections connections_princeton.csv
```

That writes `packages/brain/data/connectome.bin` (gitignored; `--out` puts it elsewhere) in a couple of seconds: 166,700 neurons, 6,242,118 connected pairs, 89,860,280 synapses, 40 MB (21 MB gzipped). The output depends only on the data, so packing the same export twice gives the same bytes. Malformed rows and connections to unknown neurons stop the packer with the line number.

## File format

`src/format.ts` reads and writes it, with no Node APIs so it also runs in a Web Worker. Little-endian throughout:

| Bytes | |
|---|---|
| 4 | `CBUG` |
| 4 | version, u32 (currently 1) |
| 4 | header length, u32 |
| n | header, UTF-8 JSON: counts, source, each section's offset (from the start of the sections), length and element type, and the string tables |
| | zero padding to a multiple of 8 |
| | the sections, each 8-byte aligned |

Neurons are numbered in ascending root ID order. The sections:

- `rootId` u32[N]
- `ptr` u32[N+1], `post` u32[E], `count` u16[E]: outgoing connections in CSR form. Neuron i's targets are `post[ptr[i]..ptr[i+1]]`, ascending, each with `count` synapses summed over neuropils (clamped to 65535).
- `superClass`, `class`, `subClass`, `nt` (predicted transmitter), `side` (soma side), `nerve` u8[N] and `type` (primary cell type) u16[N]: indices into the header's sorted string tables. Blank is `""`, always code 0.
- `ntConfidence` u8[N]: predicted transmitter confidence, 0 to 100 (0 when blank).

`loadConnectome(buffer)` validates everything and returns typed-array views into the buffer, with `find({ type: "DNp01" })`, `find({ superClass: /^visual/, side: "left" })`, `filter(i => ...)` and `indexOf(rootId)` for picking neurons.

## Neuron model

`src/sim.ts` steps leaky integrate-and-fire neurons, after Shiu et al. (2024). Each neuron has a membrane potential v and a synaptic drive g, both in mV above rest:

- `dv/dt = (g + bias - v) / tauMem`, `dg/dt = -g / tauSyn`
- spike when v reaches the threshold, then v resets to 0 and holds for the refractory period
- a spike adds `count × gain[pre] × postScale[post]` to each target's g after the synaptic delay

Defaults: dt 0.5 ms, tauMem 20 ms, tauSyn 5 ms, threshold 7 mV, refractory 2.2 ms, delay 1.8 ms. `gain` is per presynaptic neuron and signed (`gainByTransmitter` builds it from the predicted transmitter); 0 mutes a neuron's output.

Only neurons with state cost anything. A neuron joins the active set when a spike reaches it or an input fires it, and leaves once v and g have both decayed below `epsilon` (1e-3 mV) and it is not refractory; that check runs every 16 steps. The rest cut is the only difference from stepping every neuron, and the tests hold the engine to a dense reference bit for bit. Inputs are named groups driven as independent Poisson trains (sampled per spike, not per neuron per step); readouts are named groups whose spikes are counted. Runs are deterministic for a seed.

On an M5 Pro (`node packages/brain/scripts/bench.ts`), wall time per simulated second:

| Regime | Active neurons | Wall time |
|---|---|---|
| No input | 0 | ~0 s |
| Looming (LPLC2 and LC4 at 100 Hz), ±0.07 mV per synapse | ~25,000 (about 1,000 firing) | ~0.10 s |
| Same at ±0.275, modulators excitatory: runaway | ~119,000 (18,000 firing) | ~0.75 s |

The time goes almost all into updating the active set, about 2 ns a neuron a step.
