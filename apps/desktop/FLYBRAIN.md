# Fly brain

With **Fly Brain** checked in the tray or right-click menu, a spiking
simulation of the fruit fly's nervous system (`@ladybug/brain`) decides how the
ladybug wanders. It's off by default. The setting is kept in `settings.json` in
the app's user data folder, along with **Show Brain Activity**, which opens a
small panel in the top-right corner of the screen with the brain's size, spike
rate, active neurons, speed against real time and one meter per command.

The brain needs the packed connectome, `connectome.bin` (about 38 MB, not in
git; see `packages/brain`). The main process looks for it at
`LADYBUG_BRAIN_DATA` if that's set, else `<resources>/brain/connectome.bin` in a
packaged app, else `packages/brain/data/connectome.bin` in the repository.
Without it, the menu item reads **Fly Brain (Data Not Installed)** and is
disabled. electron-builder copies it into the app's resources when it exists
and warns ("file source doesn't exist") when it doesn't.

## How it runs

The brain runs in a module Web Worker (`src/brain/brain.worker.ts`), off the
render thread. `src/brain/client.ts` loads the connectome through the preload
API, transfers it to the worker and ticks it from the pet's animation loop:

- At most one tick is with the worker at a time. Fly time that passes while
  it's busy goes out with the next tick, up to 100 ms; beyond that it's
  dropped, so a slow brain runs slower than real time rather than falling
  further and further behind.
- A tick unanswered for 2 s, a worker error, or a brain that takes over 30 s to
  start fails the brain: the worker is terminated and the pet goes back to
  wandering on its own. Turning **Fly Brain** off and on again retries.
- Turning it off terminates the worker and frees the connectome.

## Body frame

The ladybug stands facing the viewer, so **the fly's left is the right of the
screen**. Everything below follows from that.

## Senses (`src/brain/senses.ts`)

| Sense | From |
| --- | --- |
| `loomLeft`, `loomRight` | The cursor swatting at the bug: nothing below 2500 px/s closing speed or beyond 350 px, full at 5000 px/s up close. A reach to click the bug or hand it a link has slowed down by the time it's that close, so it doesn't loom. Held briefly, then fades over 200 ms. A cursor on the right of the screen looms in the left eye; one nearly straight above or below looms in both. Nothing while the bug is held. |
| `touch` | 0.4 while the pointer rests on the bug, 1 while it's pressed or dragged, easing out over ~300 ms. |
| `bumpLeft`, `bumpRight` | 1 while the bug is pressed against the right or left edge of its bounds, facing it or thrown against it (the left screen edge presses its right antenna), easing out. |
| `wind` | Its own speed while airborne or dragged, full at 1500 px/s. |
| `sweet` | 0.5 while a link is dragged over it; 1 when one is dropped on it, fading over 2 s. |
| `grounded` | Standing or walking. |

The main process sends the cursor position to the renderer while the brain is
on, since the click-through overlay doesn't otherwise see it. In the
development window it's relative to the window's content area.

## Actions (`src/brain/behavior.ts`)

The brain only replaces the pet's idle wandering. Everything that holds the bug
still or moves it today wins: speech bubbles, the menu, sniffing and
inspecting, a link dragged over it, dragging and throwing, reactions to
verdicts and backing away from a dangerous page, nervous pottering, and bedtime (the brain rests while the pet sleeps). When
the brain is off, unavailable, failed, or its last command is over 500 ms old,
the pet wanders exactly as it does without it.

| Command | Action |
| --- | --- |
| `walk` | Walks the way it faces above 0.3, stops below 0.15, at 0.5× to 1.6× its usual speed. |
| `turn` | Integrated over time (leaking, so noise doesn't add up); past the threshold it turns around. Toward the fly's left heads right on screen. |
| `back` | When it beats `walk`, walks backwards at 0.6× speed, as when it backs away from a dangerous page. |
| `escape` | Rising past 0.5 while on its feet: a startled take-off, from a hop to the alarm jump, away from the side that loomed. Then 1.5 s before it can again. |
| `wings` | How far the wing cases open, passed to the renderer. Below 0.2 it's the brain idling, and nothing shows. |
| `groom` | Grooming with the front legs, while it stands still. The same floor applies, and a bout outlasts the command that started it, fading over about 1.5 s. |
| `feed` | Not acted on; shown in the activity panel. |

One thing the body does by itself: pressed against an edge it faces for 2 s, it
turns around. The brain feels the edge on its antenna, but nothing in the model
turns the fly away from it.

Commands are smoothed a little, since they arrive at uneven intervals; `escape`
is read raw because the giant fiber fires in short bursts.

## Tests

`npm test -w @ladybug/desktop` covers the settings store, the connectome path,
the worker protocol, the client (with a fake worker), the senses and the
behaviour.
