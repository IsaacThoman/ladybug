# @ladybug/brain

A spiking simulation of the male fruit fly's whole central nervous system, about 167,000 neurons wired as they are in the real animal, that drives the desktop pet. `src/types.ts` is the contract with the pet; this package turns senses into firing of the fly's sensory neurons and reads its descending and motor neurons back out as commands. `createBrain(data, { seed })` (`src/runtime.ts`) builds one from the packed connectome in about 0.3 s; it uses no Node APIs, so it runs in the pet's Web Worker.

## Data

The wiring is the [FlyEM male CNS](https://male-cns.janelia.org/) connectome from Janelia Research Campus, published under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Anything that ships the packed file, or shows behaviour derived from it, should credit "FlyEM male CNS connectome, Janelia Research Campus (CC-BY 4.0)". The packed file records the dataset, license and URL in its header.

It is not in git. The quickest way to get it is to download the packed file (21 MB) from this repository's releases, which checks it against a known hash:

```sh
npm run brain:fetch
```

Or build it yourself: export the neuron and connection tables from Codex (`neurons.csv` and `connections_princeton.csv`; either may be gzipped, whatever the file name says) and pack them:

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

`src/sim.ts` steps leaky integrate-and-fire neurons in the style of Shiu et al. (2024, "A Drosophila computational brain model reveals sensorimotor processing", Nature 634). Each neuron has a membrane potential v, a synaptic drive g and an adaptation a, all in mV above rest:

- `dv/dt = (g + bias - a - v) / tauMem`, `dg/dt = -g / tauSyn`, `da/dt = -a / tauAdapt`
- spike when v reaches the threshold; v resets to 0 and holds for the refractory period, a grows by the adaptation increment, and with `resetDrive` g is cleared to 0 too
- a spike adds `count × gain[pre] × postScale[post]` to each target's g after the synaptic delay

Engine defaults: dt 0.5 ms, tauMem 20 ms, tauSyn 5 ms, threshold 7 mV, refractory 2.2 ms, delay 1.8 ms, no drive reset, no adaptation. `gain` is per presynaptic neuron and signed (`gainByTransmitter` builds one from the predicted transmitter); 0 mutes a neuron's output. The brain runs it at the operating point below.

Only neurons with state cost anything. A neuron joins the active set when a spike reaches it or an input fires it, and leaves once v, g and a have decayed below `epsilon` and it is not refractory; that check runs every 16 steps. The rest cut is the only difference from stepping every neuron, and the tests hold the engine to a dense reference bit for bit, with and without the reset and adaptation. Inputs are named groups driven as independent Poisson trains (sampled per spike, not per neuron per step), either all at one rate (`addInput`, `setRate`) or each neuron at a rate of its own (`addRatedInput`, `setRates`, which the eyes use: candidates are drawn at the fastest neuron's rate and each kept with its own rate over that, so the cost is per candidate, about neurons × fastest rate × dt). Each input draws from its own stream, seeded by the order inputs were added, so adding one leaves the others' spikes as they were. Readouts are named groups whose spikes are counted. Runs are deterministic for a seed, and the dense reference holds both kinds of input to the same spikes bit for bit.

On an M5 Pro (`node packages/brain/scripts/bench.ts`, engine defaults), wall time per simulated second:

| Regime | Active neurons | Wall time |
|---|---|---|
| No input | 0 | ~0 s |
| Looming (LPLC2 and LC4 at 100 Hz), ±0.07 mV per synapse | ~25,000 (about 1,000 firing) | ~0.10 s |
| Same at ±0.275, modulators excitatory: runaway | ~119,000 (18,000 firing) | ~0.77 s |

The time goes almost all into updating the active set, about 2 ns a neuron a step.

### What was checked against Shiu et al.

The paper's methods were not readable here, but its code is public ([philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model), `model.py`). Its parameters match ours: rest and reset -52 mV, threshold -45 mV (7 mV above rest), membrane time constant 20 ms, synaptic time constant 5 ms, refractory period 2.2 ms, delay 1.8 ms and w_syn 0.275 mV per synapse, the one free parameter. Three details differ from what this engine did by default:

- its reset is `v = v_rst; g = 0`: a spike clears the synaptic drive. That is `resetDrive` here, and it matters: without it, leftover drive refires strongly driven neurons and the network runs away.
- its equations are frozen during the refractory period ("unless refractory"), so g neither decays nor is lost then; here g keeps decaying.
- its Poisson inputs add 250 × w_syn (68.75 mV) to v, so each input event fires the neuron, and driven neurons have no refractory period; here inputs fire the neuron directly and it keeps its refractory period.

The signs come from a precomputed column in its data, not from code we could read. A review (the State of Brain Emulation Report, 2025) describes them as acetylcholine excitatory, GABA and glutamate inhibitory, and dopamine, octopamine and serotonin excitatory. We have not confirmed that from the paper itself. Their model was the FlyWire connectome of a female brain; this is the whole male CNS, ventral nerve cord included.

## The operating point

`src/params.ts`. The starting point is "synapse count × sign" at Shiu et al.'s settings, which on this connectome is epileptic: activity anywhere spreads into saturated firing that never stops. Each departure below removed a specific runaway that `scripts/probe.ts --after` exposed, and none lowers the global weight, which stays at the paper's 0.275 mV per synapse.

| Departure from count × sign | Neurons or connections | Why |
|---|---|---|
| Kenyon cells (`KC*`) are cholinergic | 4,064 predicted dopaminergic | They are cholinergic (Barnstedt et al. 2016); as dopamine they would either excite the whole mushroom body or, muted, silence its output. |
| Photoreceptors with no prediction are histaminergic, inhibitory | 4,045 | All photoreceptors are histaminergic; histamine is treated as inhibitory (it opens chloride channels in their targets). |
| Sensory neurons outside the eye with no prediction are cholinergic | 2,127, most head bristle neurons among them | Fly mechanosensory, gustatory and olfactory neurons are cholinergic; without this most of the head's touch neurons would be mute. |
| Lateral antennal lobe local neurons predicted cholinergic are GABAergic | 75 (`lLN1_bc`, `lLN2T`, `lLN2X` and others) | The large majority of antennal lobe LNs are GABAergic (Chou et al. 2010). As predicted, these neurons are wired nearly all-to-all with ~200 synapses a pair, and any olfactory input, even spontaneous firing at 10 Hz, locked the antennal lobe at ~370 Hz for good. The least certain fix: we could not confirm these types' transmitter. |
| Dopamine, serotonin and octopamine are muted | 951 after the fixes | Their effects are slow and modulatory, not fast synapses. Shiu et al. reportedly made them excitatory. |
| No predicted transmitter: muted | 10,152, mostly motor neurons (674 of 708 in the VNC) and optic lobe neurons | Nothing to go on. Motor neurons are read, not relied on for their outputs. |
| Synaptic saturation: a connection of n synapses counts as 75 × (1 − e^(−n/75)) | all pairs: 10 → 9, 50 → 36, 100 → 55, 200 → 70, never above 75; 82% of all synapses kept | One presynaptic spike can't drive its target arbitrarily far (a real synapse's current falls as the membrane nears its reversal potential). Without it, pairs like the two DNg33 neurons, which excite each other through 1,496 synapses, ping-pong forever. |
| Spike-frequency adaptation, 0.1 mV a spike, decaying over 1 s | every neuron | Recurrent excitatory clusters still sustained themselves, notably one in the gnathal ganglia (GNG019, GNG334, GNG065 with GNG479/GNG099 inhibition, driving pharyngeal motor neurons MN10/MN11) that kept pumping after any taste. Real neurons adapt, and slow currents are what end such bursts. Weak and slow, it barely touches brief responses. |
| dt 1 ms instead of 0.1 ms | | Less than half the cost of 0.5 ms with much the same responses; the refractory period and delay round to 2 ms at either. |
| Left/right input balancing | see Senses | The sides were not reconstructed equally well (the right antenna's Johnston's organ neurons have 46,213 output synapses, the left's 150,629). At full strength each side's group delivers the same synapse-spikes per second: the side with more synapses is driven slower. |

The engine's `epsilon` is 0.01 mV here (against a 7 mV threshold).

With these, from rest, any sense or pair of senses or everything at once, held at full strength for 2 s, is followed within 1 s by activity inside the resting band (`report.ts` section b, 37 of 37).

## Senses

`src/io.ts`. Each sense drives Poisson firing in its neurons at its intensity times the maximum rate. Left and right are the fly's own.

| Sense | Neurons | Count | Max rate |
|---|---|---|---|
| `loomLeft`, `loomRight` | Looming detectors LPLC2 and LC4 of that eye | 165 left, 146 right | 100 Hz |
| `touch` | Head mechanosensory bristle neurons (`BM*`, cb_sensory) | 932 | 50 Hz |
| | Body and leg mechanosensory bristle neurons (vnc_sensory, subclass mechanosensory_bristle) | 2,206 | 10 Hz |
| `bumpLeft`, `bumpRight` | Johnston's organ neurons (`JO-*`) of that antenna | 348 left, 324 right | 30.7 Hz left, 100 Hz right (balanced) |
| `wind` | Wind- and gravity-sensitive Johnston's organ neurons (subclass wind_gravity) of both antennae | 475 | 100 Hz |
| `sweet` | Head taste neurons dorsal_tpGRN, LB3d, PhG9, LB3c, LB2a, LB4a, LB3b, PhG1c, PhG3 | 88 | 100 Hz |
| `grounded` | Campaniform sensilla (load sensors) of the legs, firing tonically while it stands | 426 | 20 Hz |

Sides: the looming detectors, Johnston's organ and head bristle neurons all have a side. Most VNC sensory neurons don't (5,297 of 6,370 are blank, and the `nerve` column is blank for every sensory neuron), so the body senses, touch and grounded, are whole-body and ignore side. Touch's two groups have different rates because there are more than twice as many body bristle neurons, and touching the pet's body excites only some of them.

Nothing in the data says which taste neurons sense sugar. `sweet`'s were chosen by what they do in the model: starting from none of the head's taste neuron types (cb_sensory, class gustatory), the type that raised the proboscis motor neuron MN9's rate most when driven at 100 Hz for 500 ms together with those already chosen was added, until no type added 1 Hz. Driven alone, no type raises MN9 by more than 8 Hz; together the nine reach 48 Hz. `node packages/brain/scripts/probe.ts --superClass cb_sensory --class gustatory --each type --target MN9 --greedy` repeats it. Some of them may well be bitter or water neurons in the real fly.

## The eyes

`src/eyes.ts` and `src/eye-columns.ts`. Each eye has a facet for every column of its optic lobe: 892 on the right, 880 on the left. `brain.eyes` gives each facet's viewing direction (`EyeMap`, in the order of the `light` arrays) and, for scripts, `buildEyes(connectome)` gives each facet's L1, L2 and L3 as neuron indices.

### The columns and their cells

The columns, their hex coordinates, their L1 and their type (pale, yellow, edge, dorsal rim area, unclear) come from the male CNS paper's optic column table (`optic-column-type-assignments-v1.0.xlsx`, [flyconnectome/2025malecns](https://github.com/flyconnectome/2025malecns), CC-BY 4.0, from the FlyEM male CNS dataset). Every right column has an L1; 8 left columns have none. Body IDs there are root IDs here, and every L1 resolves to an L1 of the right side.

The table has no L2 or L3, so `scripts/eyes.ts` assigns them from the connectome: each L2 (or L3) goes to the column of the L1 whose synaptic partners it shares most, by the cosine similarity of their input and output synapse counts partner by partner. A column's L1, L2 and L3 sit in the same cartridge and medulla column and share most of their partners there, so this needs nothing but the wiring. A cell is left out when its second most similar L1 is more than 0.6 times as similar as the first, and when two cells claim one column the more similar wins and the other is left out.

Checked against the Reiser lab's published assignment of the right optic lobe (`ME_assigned_columns.csv` in [male-drosophila-visual-system-connectome-code](https://github.com/reiserlab/male-drosophila-visual-system-connectome-code); GPL-3.0, so used only to check, and nothing from it is in this repository): L2 is assigned in 883 of 893 cells and 882 of those agree (99.9%; the one that doesn't is put one column over), L3 in 885 of 892 and all 885 agree. On the left, where there is nothing published to check against, the same method assigns 862 of 886 L2s and 865 of 880 L3s. Columns whose cell is missing or ambiguous have none of that type. To regenerate (`--check` is optional):

```sh
node packages/brain/scripts/eyes.ts --columns optic-column-type-assignments-v1.0.xlsx --check ME_assigned_columns.csv
```

### Why the lamina is the way in

The photoreceptors are too incompletely reconstructed to carry the input. There are 1,112 R1-R6 on the left and 2,265 on the right, where a whole eye has about 5,000, and only 296 of the left's 884 L1s (33%) and 503 of the right's 892 (56%) receive any synapse from one. The lamina monopolar cells are complete: 880 to 893 of each of L1, L2 and L3 a side. So the eyes enter one synapse in, at L1, L2 and L3, and the photoreceptors and their synapses onto the lamina are a formula (Seeing, below).

### Orientation

The hex axes were checked against the anatomy, not taken from the published picture (`column_coord.png` in the Reiser lab repository: hex1 is q, hex2 is p, the centre is [18, 19], v = p + q is vertical, h = q − p horizontal). From the public skeletons of all 1,764 L1s with a column, each L1's two ends were found (the longest path through its skeleton); its lamina end is the one among the photoreceptor terminals (nearest to the nodes of 453 right and 556 left R1-R6 skeletons) and the other is its medulla terminal. 854 right and 698 left L1s could be oriented that way; the rest were ambiguous and left out. The dataset's own axes were read from neurons whose anatomy is unambiguous: an antennal lobe projection neuron runs from the antennal lobe to the calyx toward +z and −y, so +z is posterior and −y dorsal, and the giant fibers and the left photoreceptors put the fly's left at +x. Fitting each end's position linearly to h and v, per side:

| | per +1 of h | per +1 of v |
|---|---|---|
| right lamina | x +0.81, y +0.03, z −0.58 (toward the midline, anterior) | y −1.00 (dorsal) |
| left lamina | x −0.75, y +0.13, z −0.64 (toward the midline, anterior) | y −1.00 (dorsal) |
| right medulla | x −0.66, y +0.19, z +0.72 (lateral, posterior) | x −0.26, y −0.97 (dorsal) |
| left medulla | x +0.73, y +0.15, z +0.67 (lateral, posterior) | x +0.11, y −0.99 (dorsal) |

So in both eyes v grows dorsally: the dorsal rim area columns are its top end (hex1 + hex2 from 46 to 71, against 7 to 72 for all columns), and the lamina and medulla agree. h grows toward the front of the lamina and toward the back of the medulla, which is the reversal of the anterior-posterior axis at the first optic chiasm, so the two ends were told apart correctly. The lamina lies under the retina without crossing, so h grows toward the frontal visual field. The left lobe's coordinates are the mirror image of the right's: the same [hex1, hex2] in each eye looks in mirror-image directions. How sure: dorsal is certain (the dorsal rim, and every column moves the same way); front is very likely (it rests on telling the lamina end from the medulla end, which the photoreceptor terminals and the chiasm both confirm, and on +z being posterior in this dataset, which the antennal lobe and calyx confirm). Rows of columns change position smoothly and monotonically in both lamina and medulla, with no fold.

### Viewing directions

No per-column table of measured optical axes is published for these optic lobes ([Zhao et al. 2025](https://www.nature.com/articles/s41586-025-09276-5) measured a different fly's eye by micro-CT), so the directions are idealised (`EYE_GEOMETRY` in `src/eyes.ts`). The columns sit on a regular hexagonal lattice, 5 degrees between neighbours (Drosophila's interommatidial angle is about 4.5 to 5 degrees), hex1 and hex2 being two of its axes 120 degrees apart as in the published picture, centred on [18, 19]. The lattice is wrapped onto the sphere around the centre column's direction, keeping distance and bearing from it (an azimuthal equidistant map), with the centre at 68 degrees from straight ahead and on the horizon. That puts the frontmost facets 8.5 degrees past the midline (binocular overlap about 17 degrees; Zhao et al. measured under 20), the rearmost 152 degrees back (a blind zone behind of 56 degrees; they measured about 50), and the eyes from 75 degrees below the horizon to 85 above. The dorsal rim looks 60 degrees up on average. Neighbours are 5 degrees apart near the centre and closer toward the edges, which the map squeezes (3.3 at the least, 4.3 the median); no two facets of an eye look within 3 degrees of each other. A facet takes in a cone of half-angle 5/√3 = 2.9 degrees (`acceptance`), the radius of the hexagon it covers, so the cones just cover the field; the measured acceptance angle is about 5 degrees across. What is idealised: the real lattice is irregular, its spacing varies across the eye, and the equator of the real eye is not exactly the horizon.

## Commands

Each command is read from a group's mean firing rate, smoothed exponentially, divided by the rate at which the command reaches 1 and clamped. `stats.rates` reports the smoothed rates by group name.

| Command | Neurons | Count | Smoothing | 1 at |
|---|---|---|---|---|
| `walk` | DNg100 (BDN2, forward walking) | 2 | 150 ms | 40 Hz |
| `turn` | DNa02, right minus left (each turns the fly toward its own side) | 1 + 1 | 150 ms | ±40 Hz |
| `back` | MDN (moonwalker, backward walking) | 4 | 150 ms | 40 Hz |
| `escape` | DNp01 (the giant fiber) | 2 | 40 ms | 200 Hz |
| `wings` | Indirect flight power muscle motor neurons DLM1-4, DLMn/a, DVM1a-c, DVMn/2a, DVMn/3a | 24 | 100 ms | 120 Hz |
| `groom` | Head-grooming descending neurons DNg12_a, _b, _c | 26 | 150 ms | 60 Hz |
| `feed` | MN9 (proboscis extension motor neuron) | 2 | 150 ms | 40 Hz |

No neuron is both driven and read (`wire()` refuses a connectome where one would be, and the tests check it), and nothing outside the network produces a command: each comes from spikes that travelled through it.

## Spontaneous behaviour

With no input the network is silent. Two things keep it going at rest, and neither touches a neuron that is read:

- **The legs' load sensors** fire tonically while it stands (`grounded`).
- **A visual background.** A fly at rest still sees a world. Every visual projection neuron except the looming detectors (nothing is looming) fires at a low rate, up to 6 Hz (5 Hz for the right eye, balanced: its neurons have 19% more output synapses). Each eye's rate is set by `src/state.ts`, a stand-in for internal state the connectome doesn't contain: a slowly wandering arousal shared by both eyes (time constant 10 s) and a slowly wandering scene for each eye (4 s), combined through a logistic into a level from 0 to 1. These are made-up processes, not neurons, and they act only by setting those background rates.

The behaviour then comes out of the network. The visual projection neurons drive the forward-walking DNg100 (LC9, LC12, LPC1 and LLPC types among them), so walking rises and falls with arousal, in bouts. Each eye's background drives only that side's DNa02, through the LC10 types, so the fly turns toward the busier eye; driven alone at matched strength, the left eye gives DNa02 21 Hz and the right 16.5 Hz. That central asymmetry, which the balancing doesn't touch, makes spontaneous turns lean toward the fly's left. Any other sense stops walking: it drives GNG inhibitory neurons onto DNg100.

Over 10 minutes at rest (seed 1, through the pet's thresholds; `report.ts` section c): walking forwards 43% of the time in 104 bouts (2.5 s on average), backwards once for 0.2 s, 56 turn-arounds toward the fly's left and 37 toward its right, no escapes; escape peaked at 0.23. Other seeds walk 41–47% of the time in 104–126 bouts, and turn toward the left 1.5 to 3.5 times as often as toward the right. No spontaneous grooming or feeding.

## What it does and doesn't reproduce

From the response matrix (`report.ts` section a):

- **Looming → escape.** LPLC2 and LC4 drive the giant fiber to 190–230 Hz and the flight power motor neurons to ~100 Hz: a take-off. The pet's looming pulse at full strength passes escape 0.5 in 32 ms and falls below 0.3 within 40 ms of fading; at half strength it still passes 0.5, in 48 ms. Other looming-sensitive descending neurons (DNp02, DNp04, DNp11) respond too. Escape stays below 0.3 at rest and under every other sense.
- **Sweet → feed.** The chosen taste neurons drive MN9 to ~31 Hz (feed 0.76). They were chosen for this (see Senses), so it is a demonstration that the pathway carries through the network, not evidence of which neurons are sweet. Held on, feed settles at 0.48–0.50 (seeds 1–3, seconds 2 to 10), and at 0.32–0.33 with touch at 0.4 and 0.16 with full touch. Walking stops too: over 20 s of sugar `walk` averaged 0.001–0.010. The taste neurons were chosen for MN9 alone, not for that.
- **Wind → groom.** Wind-sensitive Johnston's organ neurons drive the head-grooming DNg12 neurons to ~29 Hz (groom 0.48), as JO-C/E activation drives antennal grooming in flies (Hampel et al. 2015). Wind also opens the wings a little (0.22).
- **Touch → back.** Full touch drives MDN to ~25 Hz (back 0.63), mostly through the head bristles: touched, it backs away. Touch at the pointer-resting level (0.4) does very little.
- **Spontaneous walking and steering** as above.

Not reproduced:

- **Bump** does nothing much: Johnston's organ input reaches no walking, steering or backing readout (it drives other descending neurons, DNbe001, DNp18, DNg29, pIP1). So the pet's body turns it around at an edge by itself (see `apps/desktop/FLYBRAIN.md`); the brain doesn't.
- **Touch → grooming.** The body bristles mostly drive unnamed GNG descending neurons (DNge104, DNge122) and wing and haltere steering motor neurons, none of them a readout.
- **Losing ground contact → flight.** Airborne is the same as standing, except the load sensors' slight drive to the flight motor neurons goes away; real flies start flying when their legs lose contact.
- **DNp09 (forward walking toward objects) and DNa01** barely fire at rest and aren't read.
- **Symmetry**: mirrored looms give the same escape, and a scene on either side steers toward that side, but the left-hand steering pathway is ~25% stronger, so spontaneous turns lean left.

## Cost

On an M5 Pro, one thread (`report.ts` section d), wall time per simulated second: 0.12 s at rest, 0.14 s with the pointer resting on it (touch 0.4), 0.13 s with a full looming pulse every second, 0.16 s held and dragged (touch 1, wind 0.5, airborne: just over the 0.15 s aimed for), 0.21 s with every sense at full strength at once. Building the brain takes about 0.3 s. Almost all of it is the sweep over active neurons: at rest about 65,000 of them, nearly all genuinely depolarised by the background.

## Tools

`node packages/brain/scripts/probe.ts --type LPLC2,LC4 --side left` drives any group (by `--type`, `--superClass`, `--class`, `--subClass`, `--side`, `--nt`: comma-separated values or a `/regex/`) at `--rate` Hz for `--ms` and lists what responds, by super class and type, at the operating point. `--only <regex>` limits the list to some super classes, `--after <ms>` keeps running with the drive off to show what keeps going (driven neurons included), and `--set excitatory=0.2`, `--set saturation=0` and so on try another operating point. `--each type --target MN9` ranks each type in the selection by what it does to a target, and `--greedy` builds a set as `sweet`'s was built. The comment at the top of the file lists every option.

`node packages/brain/scripts/report.ts` measures everything above on the real connectome in about two minutes: (a) the response matrix, each sense alone at full strength and rest, with each command's mean, peak and latency to peak, and the looming pulse; (b) the seizure checks, every sense, pair and all at once; (c) 10 minutes of resting behaviour (`--minutes` to change it); (d) wall time per simulated second at rest, under typical stimulation and with everything at once. `--seed` changes the seed.

`node packages/brain/scripts/bench.ts` times the bare engine.

## Tests

`npm test -w @ladybug/brain`. Without the real data: the format, the packer, the engine against a dense reference, and the runtime on a small synthetic connectome (`src/test-helpers.ts`): decoding, the sense-to-rate mapping, left/right balancing, that no neuron is both driven and read, `createBrain` end to end and its errors, determinism. With `data/connectome.bin` (skipped without it), `src/behaviour.test.ts` checks the requirements: the real groups and their disjointness, no seizure after each sense and all at once, loom → escape timing, escape below 0.3 otherwise, mirrored looms and steering, touch → back, wind → groom, sweet → feed, loom → wings, three minutes of resting behaviour (walking 20–70% of the time in at least 15 bouts, turns both ways, no escapes; 10 minutes is in `report.ts`), and construction time and cost with twice the budgets' margins. It takes about a minute.
