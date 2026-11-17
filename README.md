# SUNDAY — Concept Model of DURO Automation

**The AI of DURO Automation.** An offline, gesture-controlled smart home
assistant. One hand, one camera, no cloud.

Concept and direction — **Hareesh Narayanan**.

> **New here?** Read [**the setup &amp; modification guide**](docs/SUNDAY-Guide.pdf)
> — 17 pages, written for someone who has never written a line of code. It covers
> installing Home Assistant from scratch, getting this running, every gesture, how
> the project was built with Claude Code, and ten prompts for changing it yourself.

Tracking, gesture classification and every decision run on the machine this is
started on. The model and its WASM runtime are served from `assets/vendor`, so
after install nothing is fetched from the internet — and camera frames never
leave the page.

## Run it

```sh
node server.mjs          # Node.js 18 or newer
```

Open **http://127.0.0.1:8000** and choose **Engage optics**. If port 8000 is
busy the app moves to the next free one and prints it, or set `PORT=9000`.

## How to use it

1. **Link your home** — paste a Home Assistant token and tick the lights to
   control. Or skip it and use the simulation.
2. **Engage optics** — allow the camera. Hold your hand about an arm's length
   away, palm toward the lens, whole hand in frame.
3. **Switch on** — hold an open palm up until the command bar fills.
4. **Turn that same hand** — **right brightens, left dims**. Tilt it or twist
   the palm over; either counts. No pinch needed.
5. **Switch off** — close your hand into a fist and hold it. This always
   works, whatever else is going on.
6. **Pick a colour** — 1, 2, 3 or 4 fingers. The brightness stays where you
   set it. *Pinch once* to keep turning the brightness with your hand in some
   other shape, *pinch twice* to stop.

## Colour

Fully saturated **red** and **green**, because any channel that is not the
colour you asked for only dilutes it. These were softened before (red carried
45 of green and blue, green carried a blue cast), which reads as pastel on a
wall.

**Blue carries a little green** — `0, 64, 255`. Not for the hue, which is
still plainly blue, but because the blue LED alone accounts for only about 7%
of what an eye reads as brightness. A pure blue room is a dark room however
high the dimmer goes, and the complaint that "brightness does not work in
that colour" was partly this.

**White is whatever white the lamp can actually make**, in this order:

1. a **dedicated white LED**, if the lamp has one (`white`)
2. a **neutral 5000 K colour temperature**, if it is tunable (`color_temp_kelvin`)
3. red, green and blue mixed, only if it can do neither

Mixing white out of three colours is both dimmer and faintly tinted, so the
first two are a real improvement wherever the lamp supports them.

## Gesture protocol

One hand. Either hand — the thumb is left out of the finger count, so every
pose reads the same left or right.

| Pose | Action |
| --- | --- |
| **Open palm** | Lights on, at the remembered colour and level |
| **Turn hand right** | Brighter |
| **Turn hand left** | Dimmer |
| **Closed hand** | Everything off — always, from any state |
| **Pinch** | Turning on, so any hand shape turns it |
| **Pinch again** | Turning off |
| **1 finger** | Red |
| **2 fingers** | Green |
| **3 fingers** | Blue |
| **4 fingers** | White |
| **Thumb up**, held | Brightness rises |
| **Thumb down**, held | Brightness falls |

The four colours all share **one brightness**. The level belongs to the room,
not to the colour, so 1-2-3-4 recolours the light you already have without
changing how bright it is.

## Pinch: the turning switch

**One pinch switches turning on, the next switches it off.** A plain switch,
with no double-pinch to get right and no timing window to hit.

It fires the moment the fingertips **touch**, not when they part, and there is
no maximum duration — hold the pinch for three seconds and it still toggles
exactly once. Requiring a quick release was a mistake worth recording: a
deliberate pinch takes half a second or more, so every real pinch was being
discarded as "not a tap" and did nothing at all.

### Re-arming, and the rotation that worked only sometimes

What protects it from firing twice is **not a timer**. A pinch releases as
soon as the gap passes 0.44 palm lengths and counts again below 0.30 — a few
millimetres apart — and a hand that has just pinched and is now *turning*
keeps its finger and thumb sitting right between them. Every drift across
that band toggled the lock, so rotation switched itself off at random. That
is the whole of "sometimes it works, sometimes it does not".

A second pinch now only counts once the hand has genuinely **opened**: the
gap has to clear **0.75 palm lengths**, well outside the hysteresis band, and
hold there for a moment. So: pinch, turn for as long as you like in whatever
shape is comfortable, open your hand, pinch again to stop.

Tested by drifting the gap back and forth across the band while turning —
six crossings, and the lock never flipped once.

The measured gap between index finger and thumb is **printed between the
fingertips at all times**, on a 0–100 scale, so a pinch can be watched closing
rather than guessed at.

### What the lock is for, and what it must never do

Rotation used to be bound to *holding an open palm*. That needed three things
recognised on every single frame — four fingers up, the thumb clearly
extended, and the lights already on — and it failed in practice for a reason
that is obvious in hindsight: **four fingers up without an extended thumb is
the white colour command.** A thumb that relaxed for a moment while turning
the wrist both dropped the knob *and* recoloured the room.

The fix was to stop deriving the knob from a pose at all: an open palm starts
it, and once it is turning it keeps the hand even if the pose slips, for as
long as the turning continues.

The lock adds the ability to turn the knob with the hand in any shape. What it
must **never** do is take the lights hostage. An earlier version made every
other gesture inert while locked, so one stray pinch left an operator unable
to switch their own lights off. Now:

- **Only colour commands are suppressed** while the knob is turning. That was
  the actual complaint, and it is all that needs suppressing.
- **A closed fist always works**, locked or not, mid-turn or not, and releases
  the lock on its way through. Nothing in this app is allowed to leave someone
  unable to switch their own lights off.
- The lock releases itself after 2.4 s with no hand in frame.

### A pinch can never pick a colour

Three separate rules make sure of it, because this failed in three separate
ways:

1. **The arch test is only applied to a closed hand**, and even then the
   count branch wants the index *curled*, which is what a pinch does to it. A pinch is "tips
   together *and* the index arched off its own knuckle" — but that second
   test exists solely to separate a pinch from a thumbs-up, and a thumbs-up
   is built on a fist. With any other finger extended the confusion cannot
   arise, so the arch is not required. Demanding it of every pinch is what
   made a pinch held with three fingers out flicker out of recognition — and
   three fingers out, with the pinch unrecognised, is **blue**.
2. **A colour needs the thumb clear of the index** — a gap of at least 0.50
   palm lengths. A hand entering or leaving a pinch passes through three and
   four fingers; those transit frames are now unreadable as colours. A real
   colour pose, thumb tucked against the palm, measures about 1.3.
3. **Fingertips touching short-circuits the pose machine entirely**, on the
   raw frame rather than the settled vote, and the hand stays inert for
   420 ms after a pinch releases while it unfolds.

## Turning: the brightness knob

**An open palm is the knob.** Hold one up and turn it — right brightens, left
dims. Nothing has to be locked first; the lock is only there for turning the
knob with the hand in some other shape.

The palm stays **passive until it is actually turned**. Showing one to switch
the lights on does not move the brightness and does not block anything; the
knob takes over only once the hand has turned past its slack.

**Two ways of turning both count**, because people mean different things by
"rotate your hand":

| | |
| --- | --- |
| **Tilt** — the in-plane lean, like turning a steering wheel | counted one for one |
| **Twist** — pronation, like turning a doorknob | past 15° of slack, at 0.6 weight |

The twist is weighted at 0.6 because the two are not independent in practice
— turning a wrist does some of both, and counting each at full weight moved
the lights twice as far as the hand had actually turned.

The twist is an out-of-plane rotation, invisible to the tilt measurement, and
it is recovered from the metric 3D landmarks: the angle of the palm's normal
about the hand's own long axis. Only the *change* in it is ever used, which is
what makes it safe to ignore handedness — turning a hand over flips the
normal and offsets the angle by 180°, but the direction of a turn is
unaffected. Its slack is larger than the tilt's because depth is the noisiest
thing the model reports, so jitter from a hand held still never reaches it.

The level is **printed in the middle of your hand at all times**, with the
gauge ring and needle around it.

| | |
| --- | --- |
| Engages | once the hand turns past the slack |
| Slack around the start | 5° tilt, 15° twist |
| Full 0–100 travel | 60° past the slack |
| First 10° of turn | about 9% |
| First 20° | about 23% |
| 45° | about 68% |
| Half range (50→100%) | about 41° |
| Floor | 2% — the knob dims, it does not switch off |
| Auto-release | after 2.4 s with no hand in frame |

It is **relative, not absolute**: the knob picks up the level the lights are
already at, so engaging it never moves anything, and turning back to where you
started returns the level you started with.

### The response curve

A straight 1:1 mapping has to choose between being fine enough to land on a
number and being coarse enough to reach both ends, and at 80° for the full
range it was neither — an ordinary wobble of the wrist threw the lights across
forty per cent.

The normalised turn is raised to the power 1.35, so the knob moves gently at
first and gains authority the further it goes. The span has been wrong in
both directions more than once — 80° mapped straight threw the lights across
the room on a wobble, 110° curved meant wringing the wrist to reach the top,
75° was still asking too much — and 60° with a gentler curve settles it:

| Turn past the slack | Change |
| --- | --- |
| 10° | 9% |
| 20° | 23% |
| 30° | 39% |
| 45° | 68% |
| 60° | 100% |

Those numbers are now pinned from **both** sides in the test suite: ten
degrees must move the lights at least 6% and at most 13%. A retune in either
direction fails it.

The inverse is exact, which matters because the anti-windup re-anchor has to
place the knob at precisely the turn that produced the end it hit.

The filters were slowed to match — 110 ms on the angle, 240 ms on the level —
so the light glides rather than steps.

Four details decide whether it feels accurate:

- **Smoothing is measured in time, not in frames.** Both filters — one on the
  angle, one on the level — are exponential with a time constant (70 ms and
  110 ms). A per-frame fraction would make the same wrist turn move the lights
  at a different speed on a machine running at 12 fps than at 60. Expressed as
  time, 12, 30 and 60 fps all land on the same level.
- **The angle comes from four knuckles averaged**, not one landmark. A single
  point wanders several degrees a frame; the average holds inside 2°.
- **The track is unwrapped**, so rolling past vertical reads as 2° of travel
  rather than a 358° flick.
- **Anti-windup.** Once the level pins at either end the start point is moved
  to exactly the roll that produces that end, so reversing answers on the very
  next frame instead of unwinding slack first.

A blink in tracking — up to 420 ms — does not drop the knob, and when the hand
comes back it re-anchors where it stands, so the gap costs nothing and moves
nothing.

### Command colour code

| Colour | Meaning |
| --- | --- |
| Cyan | Tracking — rotation off |
| Green | Fingertips pinched |
| Pale cyan | Tap again to release |
| Amber | Rotation locked — roll to dim |

The same four colours drive the hand overlay, the gauge chip on the camera
view and the edge of the stage, so the state is legible out of the corner of
an eye while you are watching your own hand.

### Guarding against accidental colour changes

### Why the lights used to come on blue

Opening a hand counts one, two, three, four on the way. **Three is blue.** So
a hand opened to switch the lights on armed blue in passing, and the palm
arriving a moment later switched the room on in blue — which is what the
remembered colour is for, faithfully restoring the wrong answer.

The decisive guard is the settle timer: a colour only fires once the finger
**count itself** has been unchanged for 620 ms (820 ms for white). A hand in
the middle of opening changes its count every few frames and can never
satisfy that, however long any one count happens to linger on the way.

Six things keep a colour from firing by accident:

1. **The settle timer** above — the count must be 620 ms old, 820 ms for
   white, since four fingers is one relaxed thumb from an open palm.
2. **The lock.** While rotation is locked, colour poses are inert.
3. **A 700 ms cooldown** between any two commands, which stops a hand wavering
   between three and four fingers from strobing the room.
4. **Every frame in the vote window must agree**, not merely four of five.
5. **The fingers must have stopped moving.** Fingertip travel *relative to the
   palm* is measured in palm lengths per second: a held pose sits around 0.05,
   and anything above 2.2 is a hand still changing shape. Measuring how fast
   the hand crossed the frame — which this did first — was the wrong thing
   entirely: opening a fist barely moves the palm, while simply carrying a
   perfectly good pose across the frame was blocked.
6. **A turning knob keeps the hand.** If the pose slips mid-turn — a thumb
   relaxing out of an open palm — the knob holds on rather than handing the
   hand back to the pose machine, where white is waiting. It only lets go once
   the turning has stopped for 900 ms.

### A colour change holds the level

Colour commands used to carry no brightness at all, so that one could never
clobber the other. That turned out to be wrong for a lamp that changes
colour *mode*: asked to move between RGB and colour temperature, this one
comes back at its own idea of brightness, and picking white took the room to
full every time. Every colour command now carries the level the lights are
currently at, which holds it across the mode change.

A colour also only reaches a lamp the app believes is **on**. That makes the
app's idea of on-and-off load-bearing, so if it believes everything is off it
re-checks with Home Assistant first — a stale "off" is otherwise
indistinguishable from a colour command that silently did nothing.

### Switching off always wins

The knob fires a brightness command every 110 ms. One already in flight when
a fist lands would arrive *after* the `turn_off` and light the room straight
back up — which reads, exactly as it was reported, as a closed fist that does
not switch the lights off. Switching off therefore holds brightness commands
for 900 ms and drops the knob, so the stragglers cannot undo it.

### Pinch versus thumbs-up

The hardest pair to separate, because a thumbs-up puts the thumb tip right
beside the curled index — roughly where a pinch puts it. Two independent tests
settle it, and they cannot both pass:

- A **thumb pose** needs the tips clearly **apart** (gap above 0.45 palm
  lengths), thumb straight and vertical.
- A **pinch** needs the tips clearly **together** (below 0.30) *and* the index
  arched away from its own knuckle, which a folded finger never is.

Measured on reference poses: gap 0.02 against 0.55, arch 0.77 against 0.05.

### Brightness never disturbs colour

A brightness change sends only `brightness`; a colour change sends only
`rgb_color`. Dimming a blue light leaves it blue, and recolouring a light at
40% leaves it at 40% — white included. There is one brightness in the system
and nothing but a brightness command moves it.

### SUNDAY remembers

Colour and brightness are kept in the browser and survive a reload — one
colour, one level, shared by all four tints. Switching off records where
things were; switching back on restores that exact colour and level. While a
light is off its card shows the level it will resume at.

### Timing

| Pose | Confirms after |
| --- | --- |
| Hand turn | once past the slack, then continuous |
| Pinch once (lock) | on contact, nothing deferred |
| Pinch twice (release) | on the second contact, ~170 ms |
| Colour 1–3 | ~600 ms |
| Colour 4, white | ~880 ms |
| Open palm (on) | ~670 ms |
| Closed hand (off) | ~800 ms |
| Rotation | anchors on the first frame after the lock |
| Thumb ramp | arms after ~530 ms, then glides at 24%/s |

Turning everything off by pose is the one destructive action, so the fist is
held longest.

Keyboard equivalents: `1` `2` `3` `4` colours, `5` on, `0` off, `Space` lock
and release rotation, `Enter` toggle power, `→` / `↑` brighter, `←` / `↓`
dimmer.

## Difficult lighting

The camera is the weakest link. A room lit to 100% in a saturated colour clips
the sensor; a dark room starves it. Both make the model lose the hand.

Rather than guess, SUNDAY **measures** each frame on a 32×24 probe — mean
luminance and mean saturation — and corrects the image before detection:

- **Dark room** — exposure gain up to 3.2× plus contrast.
- **Strong colour cast** — saturation pulled down, because the model reads
  shape far better than a red-on-red silhouette.
- **Blown out** — exposure pulled back.

If tracking is still lost the correction escalates, finally going monochrome,
and the model's confidence threshold drops from 0.65 to 0.40. That last switch
rebuilds the MediaPipe graph and costs a few frames, so it is rate-limited to
once every six seconds — a setting that flapped would stutter worse than the
problem it fixes. Everything relaxes again after a clean run.

When no correction is needed the camera is fed straight through, so the common
case costs nothing. The **Optics** readout shows what is being applied.

### The overlay has to know where the image is

The camera fills the stage with `object-fit: cover`, so unless its aspect
ratio happens to match it is scaled up and **cropped**. Landmark coordinates
are fractions of the camera frame, not of the element, so painting them
straight onto the element box — which is what this did — puts the skeleton
near the hand rather than on it: out by up to an eighth of the height and a
third of the scale on a 4:3 camera in a 16:9 frame. Every landmark now goes
through the computed view box first.

## How the tracking works

MediaPipe supplies 21 landmarks per hand; every decision after that is ours, in
`hand-model.js` — a pure module with no DOM access.

- **Finger extended** — the angle at the PIP joint exceeds 150°, *and* the
  fingertip reaches further from the wrist than its own middle joint by at
  least 14%. Both must agree, which rejects half-curled poses that a single
  test misreads.
- **Thumb extended** — the same radial-reach rule, measured from the wrist. A
  "spread from the index knuckle" test only recognises a thumb held out
  sideways and misses an open hand where the thumb rises alongside it.
- **Pinch** — thumb and index tips close *and* the index arched away from its
  own knuckle. The gap alone is not enough: with the hand curled, the thumb tip
  also sits beside the folded index, and that second test removes the false
  positive.
- **Hand roll** — the lean of the hand's long axis, taken from the wrist to
  the centre of the four knuckles. It is the one deliberately screen-relative
  measurement in the module, reported in the mirrored frame the operator
  actually sees, so "right" on screen is "right" to the hand.
- **Hand twist** — the angle of the palm's normal about that same axis, from
  the metric 3D landmarks. Held at its last value when the hand points at the
  lens, where there is no reference direction perpendicular to the axis, and
  a step larger than 30° in one frame is rejected outright — the palm normal
  comes from landmark depth, the weakest thing the model reports, and on a
  hand seen nearly edge-on it can flip. No wrist turns 180° in a thirtieth of
  a second.
- **Deliberately unmapped** — four fingers without the thumb, a lone thumb, or
  any half-made shape. These are what a hand passes through on the way
  somewhere else, and giving them an action is what causes accidental
  triggers.

Because these are angles and ratios rather than "tip above knuckle", a rotated,
tilted or mirrored hand reads the same.

Every threshold is **hysteretic** — once a finger counts as extended it takes a
clearly smaller angle to drop it — so the readout does not flicker between two
counts while a hand is held still.

On top of that, a command needs a **majority vote across 5 frames** (4 must
agree), and an unsettled frame holds the current state rather than resetting
it. A single bad frame can never reach your lights.

The pinch is the one exception: its edges are handled on raw frames rather
than on the vote, which is what makes the lock feel instant.

Two test suites cover this:

- **91 classification cases** — poses × variants (upright, rotated
  25°/−40°/90°/180°, mirrored, near, far, noisy), the pinch/thumbs-up
  separation margin, and both hysteresis paths.
- **99 control cases** covering the roll measurement against synthetic hands
  at nine angles, the ±180° seam, the roll-to-brightness mapping and its
  anti-windup, frame-rate independence at 12/30/60 fps, tracking dropouts, the
  pinch lock machine (contact locks, a second contact releases, a pinch held
  for two seconds still locks exactly once, a single pinch while locked does
  not toggle off), a pinch with three fingers out never reading as a colour
  at any index curl, no pose firing while rotation is locked, and white
  needing its longer hold, both ways of turning a hand adding up correctly, a
  the response curve staying fine at small turns while still reaching both
  ends, its inverse round-tripping exactly, a bouncy pinch release not
  toggling twice, a hand opening from a fist to a palm firing no colour on
  the way — fast or slowly, half a second on every count — a hand whose
  fingers are still moving not being allowed to pose one, a hand drifting
  across the pinch hysteresis band staying locked, a fist firing even
  while locked
  and even mid-turn, and a palm held without turning still letting colours
  through. Its timing
  constants are **scraped out of `app.js` at run time** rather than copied, so
  retuning the app cannot leave the tests checking old numbers.

## Linking Home Assistant

1. Home Assistant → your name → **Security** → **Create token**.
2. **Link home**, enter the address, paste the token.
3. Tick the nodes to control (up to eight).

The token is held in the local server's process memory only — never written to
disk, never logged, never returned to the browser. Only the address is kept, in
the browser, to prefill the form. **Unlink**, or stopping the server, clears it.

The proxy accepts requests only from this machine, allows only `turn_on`,
`turn_off` and `toggle`, and only on the nodes you ticked.

### If linking fails

| Message | What to do |
| --- | --- |
| Rejected the access token | Token wrong, expired or revoked — create a new one. |
| The name could not be found | Use the IP, e.g. `http://192.168.1.25:8123`. |
| Refused the connection | Wrong port. Home Assistant normally uses 8123. |
| Did not answer in time | Different network, or wrong address. |
| REST API was not found | Remove any extra path from the address. |
| Certificate could not be verified | On a home network use plain `http://`. |
| Local server not responding | `node server.mjs` is not running. |

## Accessibility

Every gesture has an on-screen control and a keyboard equivalent. Screen-reader
announcements on each state change, visible focus rings, and
`prefers-reduced-motion` disables the scan sweep, reactor spin and nebula.

This is a concept demo, not a certified accessibility or safety system. Do not
rely on it as the only way to control critical devices.

## Layout

```
server.mjs        local file server + Home Assistant proxy (holds the token)
app.js            UI, HUD painting, gesture state machine, device control
hand-model.js     pure hand geometry — classification and smoothing
index.html        structure
styles.css        teal-and-orange HUD theme
assets/vendor/    hand_landmarker model + MediaPipe WASM (offline)
```
