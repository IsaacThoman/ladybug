# Fly brain

With **Fly Brain** checked in the tray or right-click menu, a spiking
simulation of the fruit fly's nervous system (`@ladybug/brain`) decides how the
ladybug wanders. It's off by default. The setting is kept in `settings.json` in
the app's user data folder, along with **Show Brain Activity**, which opens a
small panel in the top-right corner of the screen with the brain's size, spike
rate, active neurons, speed against real time and one meter per command.
**Fly Eyes**, below them, lets the brain see the screen (see Eyes); it's off by
default too, and only available while Fly Brain is on.

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
| `loomLeft`, `loomRight` | The cursor swatting at the bug: nothing below 2500 px/s closing speed or beyond 350 px, full at 5000 px/s up close. A reach to click the bug or hand it a link has slowed down by the time it's that close, so it doesn't loom. Held briefly, then fades over 200 ms. A cursor on the right of the screen looms in the left eye; one nearly straight above or below looms in both. Nothing while the bug is held. With Fly Eyes on and a brain that has eyes, always 0: the cursor is something the eyes see instead. |
| `light` | With Fly Eyes on and a brain that has eyes: how bright each facet's patch of the world is (see Eyes). Left out otherwise. |
| `touch` | 0.4 while the pointer rests on the bug, 1 while it's pressed or dragged, easing out over ~300 ms. |
| `bumpLeft`, `bumpRight` | 1 while the bug is pressed against the right or left edge of its bounds, facing it or thrown against it (the left screen edge presses its right antenna), easing out. |
| `wind` | Its own speed while airborne or dragged, full at 1500 px/s. |
| `sweet` | 1 while it's on its feet and touching a berry: one within 66 px of its middle, on or near the ground, so under its feet or at its mouth (flies taste with both). 0.5 while a link is dragged over it; 1 when one is dropped on it, fading over 2 s. |
| `grounded` | Standing or walking. |

The main process sends the cursor position to the renderer while the brain is
on, since the click-through overlay doesn't otherwise see it. In the
development window it's relative to the window's content area.

## Eyes (`src/brain/eyes.ts`, `src/brain/vision.ts`)

With **Fly Eyes** on, and a brain that says where its facets look (`eyes`,
about 890 per eye), every tick's senses carry `light`: how bright the world is
in the direction each facet looks, averaged over its cone, from 0 (black) to
1 (white). The brain takes it from there, in through the visual system.

### What the bug sees

The bug is a small animal standing on a ledge just in front of the screen, and
the screen's surface is a luminous wall behind it. The ledge runs along its
ground line, from the wall out toward you. Everything a facet can look at is:

| Looking at | Sees |
| --- | --- |
| The wall, above the ledge and within the screen | The screen there (see below), averaged over the facet's footprint. |
| Down at the ledge, in front of the wall | 0.2: the ledge, in its own shade. |
| Out toward you, or past the screen's edges | 0.3: the room, dimmer than the screen. |
| The berry | 0.3: a dark blue ball 20 px across, on the ledge beside the bug, as far from the wall as its middle. |

The cursor is part of the wall: a black arrow (0.05) at its real size, about
11 by 21 px, drawn where it is now, every frame.

Where the eyes are and which way they face:

- **Facing.** Whatever the renderer last drew (`LadybugRenderer.facing`):
  facing you while it stands idle, turned 1.1 radians (about 63°) toward its
  heading while it walks, and eased between the two, spins and all. Facing you,
  its left eye looks at the right of the screen; walking right, the wall is on
  its left.
- **Eye height: 20 px** above the ledge. The hit box is 60 px tall, most of it
  the domed wing cases, and the head hangs low in front of them.
- **Distance from the wall: 60 px** to the middle of its body, a little over
  half its length (100 px), so it could turn round without touching the screen;
  its eyes are **35 px** ahead of that. Facing you they're 95 px from the wall,
  walking about 76 px.

Those numbers set how the screen looks to it. Close to its own feet, a facet's
footprint on the wall is a few px across; up the screen, at a grazing angle,
it's stretched into a long smear, so the bug sees what's near it sharply and
the rest of the screen only as broad patches of light. A cursor next to it
covers several facets; across the screen it's smaller than one.

Each facet's cone is averaged over seven rays: one down its middle and a ring
of six at 0.7 of its half-angle, each taking a seventh of the cone. Each ray
ends on the berry, the ledge, the room or the wall; on the wall it takes the
average over its own footprint, a circle stretched along the ray's slant (at
most 20 times), with whatever of it falls past the screen's edges counted as
room and below the ledge as ledge.

### The wall's picture (`src/brain/wall.ts`)

The wall is a small picture of how bright the screen is, one cell for about
6 px (288 × 186 on a 1728 × 1117 screen), with a summed-area table, so any box
of it averages in constant time. It comes from one of two places:

- **The plain wall**: mid-grey (0.5) everywhere. What it sees when it can't
  see the screen.
- **The screen itself**, captured (`src/brain/eyes-capture.ts`): the primary
  display, at about twice the picture's resolution and 10 frames a second, read
  into the picture 8 times a second (Rec. 709 luma of each pixel). The brain
  ticks up to 60 times a second, but only the cursor and the berry move that
  fast, and they're drawn into the scene every frame rather than read off the
  screen.

The overlay draws the bug, its berry, speech bubbles, the menu and this panel
on top of the screen, so a captured frame shows them; the bug mustn't see
itself. They're kept out of the picture: every top-level element of the page
(and the bug's canvas, which overhangs its hit box) when a frame is read, and
wherever the bug, its berry and the cursor were in the last 300 ms, 6 px
around, since a frame shows the screen as it was a little while before. What's
under them keeps what it last showed.

The cursor is in the picture exactly once. Screen captures usually include it,
but a captured frame is up to a few hundred ms old, so it's kept out of the
capture like the overlay and drawn into the scene where it is now. That holds
whether or not a platform's capture shows it.

### Seeing the screen

The page can only capture the screen during a support call (`CapturePolicy`).
The eyes have a separate, narrow allowance (`electron/eyes-capture-policy.ts`):

- Only while Fly Brain and Fly Eyes are on, and the screen can be seen: on
  macOS, with Computerbug's **Screen Recording** permission, checked with
  `getMediaAccessStatus("screen")`. Not from the development window, which
  isn't the screen, and not under Wayland, whose portal would ask every time
  the capture starts.
- The page asks the main process for the primary display's source
  (`ladybug:eyes-capture-source`). Handing it out lets the page open one
  video-only stream in the next 10 s, and nothing else: no microphone, no
  second stream, and nothing once Fly Eyes is turned off or the page reloads.
  It doesn't ask macOS for the camera, as the call does.
- macOS is only asked for Screen Recording when the user turns Fly Eyes on
  (listing the screens is what brings up its prompt), or picks **Let Fly Eyes
  See the Screen…**, which shows in the menu while Fly Eyes is on without it
  and opens System Settings once macOS has been asked. Until it's granted, the
  bug sees the plain wall and the panel says so. The main process checks every
  2 s while Fly Eyes is on, so granting it takes effect without turning Fly
  Eyes off and on (macOS may still want Computerbug restarted first).
- The capture runs only while the eyes are looking: it stops while the bug is
  asleep (the brain rests), when nothing has looked for 3 s (the pet hidden),
  and when Fly Eyes or Fly Brain goes off. A capture that fails isn't retried
  until Fly Eyes is turned off and on.

What happens to the pixels: the stream is drawn only to a canvas the size of
the picture and read back as brightness, in the renderer. The picture is all
that's kept, in memory, and it goes back to plain grey when the capture stops.
Nothing is written to disk or sent anywhere; only the facets' brightness
(about 1,800 numbers a tick) goes to the brain's worker. The screen sources are
listed without thumbnails, so no picture of the screen reaches the main
process either.

On an M5 Pro, a look through both eyes (1,750 facets of a stand-in lattice)
takes 0.2 to 0.3 ms, and reading a frame into the picture about 0.25 ms (half
drawing and reading back the canvas, half masking and the table). Looks happen
only when the brain is ready for a tick.

### Escaping

With the hand-wired looming gone, which way a fright sends the bug comes from
the eyes: a facet's worth of the view in one eye going from white to black
between two looks counts fully, and fades over 300 ms. The bug jumps away from
the eye that darkened more. It decides only the direction, never whether it
jumps; the brain does that.

### The panel

While Fly Eyes is on, the brain activity panel shows a picture of what each
eye sees, a dot per facet in grey, laid out by where it looks: across by
azimuth, up by elevation, both eyes at one scale. They're drawn as you'd see
the bug's face when it faces you, so its right eye is on the left and its left
eye on the right, each looking out to its own side. Below them is where the
picture comes from, and a meter for each `vision.<stage>` rate the brain
reports, full at 100 Hz.

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
| `escape` | Rising past 0.5 while on its feet: a startled take-off, from a hop to the alarm jump, away from the side that loomed (with Fly Eyes, the eye that darkened). Then 1.5 s before it can again. |
| `wings` | How far the wing cases open, passed to the renderer. Below 0.2 it's the brain idling, and nothing shows. |
| `groom` | Grooming with the front legs, while it stands still. The same floor applies, and a bout outlasts the command that started it: set off in the air, it waits until the bug is back on its feet, then fades over about 1.5 s. |
| `feed` | With a berry in reach, it eats once this passes 0.15 and until it falls below 0.05. The berry goes down in proportion to the command: about 6 s for a whole one with the bug left alone (`feed` settles near 0.5), about 10 s with the pointer resting on it, since touch brings `feed` down to about 0.33. Without a berry it does nothing. |

Two things the body does by itself:

- Pressed against an edge it faces for 2 s, it turns around. The brain feels
  the edge on its antenna, but nothing in the model turns the fly away from it.
- Once the brain wants to feed, it turns to the berry and shuffles the last
  few steps (at 0.6× walking speed) until the berry is at its mouth. Stopping
  for the berry is the brain's doing: `walk` falls to about zero while it
  tastes sugar. Lining its mouth up with it isn't; the model has no sense of
  where the food is.

## Feeding

**Feed**, in the menu that opens when the bug is clicked and in the tray and
right-click menu, drops a berry about 130 px from the bug (`src/food.ts`,
`src/components/Berry.tsx`). There is one berry at a time; asking again
replaces it with a fresh one. It can be picked up, carried and thrown like the
bug, and it stays where it lands until it's eaten.

With the fly brain on, the bug doesn't go to the berry: nothing in the model
could lead it there. It eats one it's touching, so hand it over or wait for the
bug to wander onto it. With the fly brain off (or unavailable, failed or
stale), the pet walks over to a berry lying on the ground and eats it at a
steady rate, as part of its own wandering.

Either way the bug only eats while it's free: awake, on its feet, and with
nothing the product does (a bubble, a scan, a reaction, the menu) holding it.
A fright interrupts a meal, and eating keeps it from going to bed.

Commands are smoothed a little, since they arrive at uneven intervals; `escape`
is read raw because the giant fiber fires in short bursts.

## Tests

`npm test -w @ladybug/desktop` covers the settings store, the connectome path,
the worker protocol, the client (with a fake worker), the senses, the
behaviour and the berry; and for the eyes, the geometry (with a stand-in
lattice of facets), the wall's picture and what's kept out of it, the capture
(with a fake stream) and the main process's allowance.
