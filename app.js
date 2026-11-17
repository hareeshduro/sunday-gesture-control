/**
 * SUNDAY — the AI of DURO Automation.
 * Concept and direction: Hareesh Narayanan.
 *
 * Offline gesture control for Home Assistant. One hand, one camera, no cloud:
 * the model and WASM come from ./assets/vendor, frames never leave the page,
 * and commands go only to the local proxy in server.mjs.
 *
 * Protocol
 *   open palm             lights on — then turn that palm to set brightness
 *   turn hand right/left  brighter / dimmer
 *   closed hand           all off, always
 *   pinch once            lock rotation so ANY hand shape turns it
 *   pinch twice           release the lock
 *   1 / 2 / 3 / 4 fingers red / green / blue / white
 *
 * Turning an open palm is the ordinary way to set brightness and needs no
 * ceremony. The pinch lock is an extra, for turning the knob with the hand
 * held in whatever shape is comfortable.
 *
 * What the lock must NEVER do is take the lights hostage. An earlier version
 * made every other gesture inert while it was locked, so one stray pinch left
 * an operator unable to switch their own lights off. Only the COLOUR commands
 * are suppressed while the knob is turning — that was the real complaint —
 * and a closed fist always works and releases the lock on its way through.
 *
 * One brightness, shared by every colour: the level belongs to the room, not
 * to the colour, so changing colour never moves it.
 */

import {
  analyseHand, classify, intentKey, majority, gapToLevel,
  rollToLevel, rollAtLevel, turnDelta, unwrapDeg, ROLL, LIMITS,
} from "./hand-model.js";

const VENDOR = "./assets/vendor";

/* Response budget. The vote window costs ~170ms at 30fps; the hold is added
   on top. Destructive poses are held longer than harmless ones on purpose. */
const VOTE_WINDOW = 5;
const VOTE_AGREE = 4;

/* Colours are held to a stricter standard than the rest, because they are
   the commands a hand fires by accident.

   Opening a fist into a palm counts one, two, three, four on the way. Three
   is blue. So a hand opened to switch the lights on would arm blue in
   passing, and the palm arriving a moment later would switch the room on in
   blue — which is exactly what was reported.

   The decisive condition is the last one: the finger COUNT itself must have
   been unchanged for a while. A hand in the middle of opening changes its
   count every few frames and can never satisfy it, however long any one of
   those counts happens to linger. */
const COLOR_SETTLE_MS = 620;     // the finger count must be this old
const WHITE_SETTLE_MS = 820;     // four fingers is a palm away; longer still
const COLOR_UNANIMOUS = true;    // every frame in the vote window must agree
const FINGER_STILL = 2.2;        // fingertip travel per second, in palm lengths
/* Colours carry only a short hold of their own, because the settle timer
   below already demands a steady count for far longer — and the two run in
   series, so doubling up would make picking a colour feel dead. */
const HOLD_MS = { color: 140, palm: 420, fist: 560 };
const REPEAT_MS = 700;

/* Pinch is the rotation gate, and it is a plain switch: one pinch turns
   turning on, the next pinch turns it off.

   It fires the moment the fingertips TOUCH, not when they part, and there is
   no maximum duration — hold the pinch as long as you like. What protects it
   from firing twice is not a timing window but the requirement that the
   fingers be properly apart again before another pinch counts. */
const PINCH_REFRACTORY_MS = 420; // after releasing, poses stay inert this long

/* The palm-roll brightness knob. Two exponential filters in series: one on the
   measured angle, where the camera jitter lives, and one on the level it
   produces, which is what the eye sees. Together they turn a noisy angle into
   a brightness that slides rather than steps.

   They are specified as time constants, not as per-frame fractions, and the
   per-frame fraction is derived from the real elapsed time. A fixed fraction
   would make the knob feel completely different on a machine running at 12fps
   from one running at 60 — the same wrist turn would move the lights at a
   different speed. Expressed as time, it behaves the same on both. */
const ROLL_RELEASE_MS = 2400;    // hand gone this long releases the lock
const KNOB_HOLD_MS = 900;        // a turning knob keeps the hand this long past a slip
const PINCH_STABLE_FRAMES = 2;   // frames of agreement before an edge counts
const PINCH_SEPARATE_MS = 260;   // fingers must part this long before a new pinch
const PINCH_CLEAR_MS = 90;       // and be properly open for this long
const ROLL_ANGLE_TAU = 110;      // ms; the hand's own wobble, filtered out
const ROLL_LEVEL_TAU = 240;      // ms; the light glides rather than steps
const ROLL_DT_MAX = 200;         // a stalled tab must not snap the knob
const ROLL_GRACE_MS = 420;       // a dropped frame or two must not drop the knob
const ROLL_SEND_MS = 140;        // Home Assistant is comfortable at ~7 cmd/sec
const ROLL_SEND_STEP = 2;        // percent of change worth a command

/* Thumb up / down ramp, kept as a fallback for a hand that cannot roll
   comfortably. Armed only after the pose has settled and held, which is what
   keeps a thumb that merely passes through from moving anything. */
const THUMB_ARM_MS = 360;
const RAMP_PCT_PER_SEC = 24;
const RAMP_SEND_MS = 180;

/* The camera is the weakest link: a room lit to 100% in a saturated colour
   clips the sensor, and a dark room starves it. Both make the model lose the
   hand. Rather than guess, SUNDAY measures the frame and corrects it before
   detection. */
const PROBE_EVERY = 10;          // frames between measurements (cheap, 32x24)
const LUMA_TARGET = 112;         // mid-grey we aim the frame at
const LUMA_DARK = 96, LUMA_HOT = 190;
const SAT_CAST = 0.40;           // above this the frame has a strong colour cast
const BOOST_LOST_FRAMES = 20;    // tracking lost this long -> push the correction harder
const BOOST_OK_FRAMES = 120;     // steady tracking -> ease it back
const LOW_CONF = { minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4 };
const HIGH_CONF = { minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.65, minTrackingConfidence: 0.65 };
const CONF_COOLDOWN_MS = 6000;   // graph rebuilds are costly; never flap

const POLL_MS = 3000;
const MEMORY_KEY = "sunday.memory";

/**
 * Fully saturated primaries — the brightest and purest a lamp can make.
 *
 * These were softened before (red carried 45 of green and blue, green carried
 * a blue cast), which reads as pastel on a wall. Every channel that is not
 * the colour you asked for only dilutes it, so they are all zero now.
 *
 * `rgb` is what the lamp is sent. `ui` is only for text and borders, where
 * pure blue on a dark panel is unreadable.
 */
const COLORS = [
  { key: "red",   name: "Red",   hex: "#ff0000", rgb: [255, 0, 0] },
  { key: "green", name: "Green", hex: "#00ff00", rgb: [0, 255, 0] },
  /* Blue carries a little green. Not for the hue — it is still plainly blue
     — but because the blue LED alone accounts for only about 7% of what an
     eye reads as brightness, so a pure blue room is a dark room however high
     the dimmer goes. This lifts the output without washing the colour out. */
  { key: "blue",  name: "Blue",  hex: "#0040ff", rgb: [0, 64, 255], ui: "#4d7dff" },
  { key: "white", name: "White", hex: "#ffffff", rgb: [255, 255, 255], pureWhite: true },
];
const WHITE_KELVIN = 5000;       // neutral daylight, where the lamp can tune

const PROTOCOL = [
  { id: "palm",       glyph: "☰", label: "Open palm",    detail: "Lights on",  accent: "var(--cyan)" },
  { id: "roll_right", glyph: "↻", label: "Turn hand right", detail: "Brighter", accent: "var(--amber)" },
  { id: "roll_left",  glyph: "↺", label: "Turn hand left",  detail: "Dimmer",   accent: "var(--amber)" },
  { id: "fist",       glyph: "●", label: "Closed hand",  detail: "All off",    accent: "var(--cyan)" },
  { id: "pinch",      glyph: "◉", label: "Pinch",        detail: "Turning on",  accent: "var(--jade)" },
  { id: "double",     glyph: "◎", label: "Pinch again",  detail: "Turning off", accent: "var(--jade)" },
  { id: "color:0",    glyph: "1", label: "One finger",   detail: "Red",   color: 0 },
  { id: "color:1",    glyph: "2", label: "Two fingers",  detail: "Green", color: 1 },
  { id: "color:2",    glyph: "3", label: "Three fingers",detail: "Blue",  color: 2 },
  { id: "color:3",    glyph: "4", label: "Four fingers", detail: "White", color: 3 },
  { id: "thumb_up",   glyph: "▲", label: "Thumb up",     detail: "Hold to brighten", accent: "var(--amber)" },
  { id: "thumb_down", glyph: "▼", label: "Thumb down",   detail: "Hold to dim",      accent: "var(--amber)" },
];

const state = {
  mode: "demo",
  devices: [], entities: [], selected: new Set(),
  target: "all",
  /* One brightness for the whole room, shared by all four colours. */
  memory: { color: 3, pct: 70 },
  landmarker: null, stream: null, frame: 0, lastVideoTime: -1,
  hand: null, prevHand: null, intent: { type: "none" },
  votes: [], stable: null,
  holdKey: null, holdSince: 0, firedKey: null, lastFired: 0, holdProgress: 0,
  locked: false,          // rotation locked on: the hand is a brightness knob
  roll: null,             // the live knob, while a hand is visible and locked
  rollGapSince: 0,        // when the knob last lost sight of the hand
  pinchDown: null,        // { t0 } while the fingertips are together
  lastTapAt: 0, pinchEndAt: 0, handLostAt: 0,
  pinchRun: 0, pinchHeld: false,   // debounce: consecutive frames of agreement
  pinchArmed: true, clearSince: 0, // the hand has opened since the last pinch
  knobSlipSince: 0,       // when a turning knob last lost its open palm
  thumb: null,            // { dir, since, pct, lastSend }
  probe: { luma: 128, sat: 0 }, probeTick: 0, filter: "", assistLabel: "Direct",
  boost: 0, lostFrames: 0, goodFrames: 0, lowConf: false, confChangedAt: 0,
  reticle: null, rect: { width: 0, height: 0 }, view: { x: 0, y: 0, w: 0, h: 0 },
  handFlux: 0, lastTips: null, lastTipsAt: 0,
  fingerCount: -1, countSince: 0,   // how long the hand has shown this many fingers
  lastTick: 0, fps: 0, fpsFrames: 0, fpsStamp: 0,
  toastTimer: 0, pollTimer: 0, quietUntil: 0, draggingId: "", holdOffUntil: 0,
  log: [], pendingPick: false,
};

const $ = (id) => document.getElementById(id);
const video = $("camera");
const canvas = $("hud");
const ctx = canvas.getContext("2d");
const dialog = $("setup-dialog");

/* Frames are pre-processed on this canvas when the room light is washing the
   camera out. Created once; sized to the video on first use. */
const work = document.createElement("canvas");
const workCtx = work.getContext("2d", { alpha: false });

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The fraction of the way to move this frame for a given time constant.
 *
 * `tau` is the time an exponential filter takes to close 63% of the gap, so
 * the smoothing is a property of the clock rather than of the frame rate.
 */
const ease = (dt, tau) => 1 - Math.exp(-Math.min(dt, ROLL_DT_MAX) / tau);
const pctToHa = (p) => clamp(Math.round((p / 100) * 255), 1, 255);
const haToPct = (v) => (Number.isFinite(v) ? clamp(Math.round((v / 255) * 100), 1, 100) : 100);

/* ------------------------------------------------------------------ memory */

/**
 * Colour and brightness survive a reload, and the brightness is a single
 * value shared by every colour: whatever level was last set is the level red,
 * green, blue and white all come back at.
 */
function loadMemory() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      const colour = (v, d) => clamp(Number.isFinite(Number(v)) ? Number(v) : d, 0, COLORS.length - 1);
      const level = (v, d) => clamp(Number.isFinite(Number(v)) ? Number(v) : d, 2, 100);
      state.memory = {
        color: colour(saved.color ?? saved.restore?.color, 3),
        // Older builds kept a second level under `restore`; fold it in.
        pct: level(saved.pct ?? saved.restore?.pct, 70),
      };
    }
  } catch { /* corrupt or blocked storage: keep the defaults */ }
}

function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory)); } catch { /* ignore */ }
}

const activeTint = () => COLORS[state.memory.color];

/**
 * What to actually send for a colour.
 *
 * White is the interesting one: mixing it out of red, green and blue is both
 * dimmer and faintly tinted, so a lamp with a dedicated white LED is told to
 * use it, and a tunable one is given a neutral colour temperature instead.
 * Only a lamp that can do neither falls back to mixing.
 */
function tintData(device, tint, pct) {
  /* The level goes with every colour change.

     The rule used to be the opposite — colour commands never carried a
     brightness, so that one could not clobber the other. But a lamp asked to
     switch between colour and colour-temperature modes may come back at its
     own idea of brightness, and this one does: picking white took the room
     to full every time. Sending the level the lights are *currently* at is
     both safe and the only way to hold it across a mode change. */
  const brightness = device.supportsBrightness ? { brightness: pctToHa(pct) } : {};
  if (!tint.pureWhite) return { ...brightness, rgb_color: tint.rgb };
  if (device.supportsWhiteMode) return { white: pctToHa(pct) };
  if (device.supportsColorTemp) return { ...brightness, color_temp_kelvin: WHITE_KELVIN };
  return { ...brightness, rgb_color: [255, 255, 255] };
}

/* ------------------------------------------------------------ local server */

async function api(path, options) {
  let response;
  try { response = await fetch(path, options); }
  catch {
    const error = new Error("Local server not responding.");
    error.hint = "Start it with: node server.mjs";
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.hint = data.hint || "";
    throw error;
  }
  return data;
}

/* ------------------------------------------------------------------ output */

const announce = (m) => { $("announcer").textContent = m; };

function toast(message, tone = "ok") {
  const node = $("toast");
  $("toast-text").textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { node.hidden = true; }, 1800);
}

function logLine(text, isError = false) {
  state.log.unshift({ text, isError, at: new Date() });
  state.log = state.log.slice(0, 6);
  const list = $("log-list");
  list.replaceChildren(...state.log.map((entry) => {
    const item = document.createElement("li");
    if (entry.isError) item.className = "is-error";
    const label = document.createElement("span");
    label.textContent = entry.text;
    const time = document.createElement("span");
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(entry.at);
    item.append(label, time);
    return item;
  }));
}

function setStatus(mode, title, detail, tone = "info") {
  $("status-pill").dataset.state = mode;
  $("status-text").textContent = mode === "live" ? "Linked" : mode === "error" ? "Fault" : "Standalone";
  $("sysline-title").textContent = title;
  $("status-detail").textContent = detail;
  $("sysline").dataset.tone = tone;
  $("sysline-action").hidden = mode === "live";
}

function refreshStatus() {
  if (state.mode === "live") {
    const names = state.devices.length === 1 ? state.devices[0].name : `${state.devices.length} nodes`;
    setStatus("live", "Home linked", `Gestures drive ${names}.`, "ok");
  } else {
    setStatus("demo", "Standalone mode", "No home linked. Controls move the simulation only.", "info");
  }
}

/* ----------------------------------------------------------- device control */

const targetDevices = () => (state.target === "all"
  ? state.devices.filter((d) => d.available)
  : state.devices.filter((d) => d.entityId === state.target && d.available));

const dimmable = () => targetDevices().filter((d) => d.supportsBrightness);
const anyOn = () => targetDevices().some((d) => d.state === "on");

/**
 * The level any brightness change continues from. A light that is on reports
 * its own level; one that is off resumes from what it had when it went off,
 * never from zero. This is what stops a second adjustment starting over at
 * the bottom.
 */
function currentLevel() {
  const live = dimmable().find((d) => d.state === "on");
  if (live) return live.pct ?? haToPct(live.brightness);
  return state.memory.pct;
}

async function callService(device, service, data = {}) {
  if (state.mode !== "live") return;
  await api(`/api/ha/services/${device.domain}/${service}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: [device.entityId], ...data }),
  });
}

function commandFailed(error) {
  logLine(error.message, true);
  announce(`${error.message} ${error.hint ?? ""}`);
  toast(error.message, "bad");
  if (error.message.includes("Local server")) setStatus("error", "Server fault", error.hint ?? "", "error");
  console.error("Command failed:", error);
}

const quietPoll = () => { state.quietUntil = Date.now() + 1400; };

/**
 * Apply a change to the live device object, looked up by id.
 *
 * Commands await the network, and the state poll can land during that await
 * and swap `state.devices` for freshly built objects. Holding a reference
 * across the await would then update an orphan and the UI would silently
 * ignore the command, so every write goes through this lookup instead.
 */
function markDevice(entityId, patch) {
  const device = state.devices.find((d) => d.entityId === entityId);
  if (device) Object.assign(device, patch);
  return device;
}

/** Switching on restores the remembered colour and level. */
async function setPower(on, devices = targetDevices(), { silent = false } = {}) {
  if (devices.length === 0) return void toast("No nodes linked", "bad");
  quietPoll();                 // hold the poll off before we start awaiting

  /* Switching off has to win. The brightness knob fires a command every
     110ms, and one already in flight when the fist lands would arrive after
     the turn_off and light the room straight back up — which reads, exactly
     as it was reported, as a closed fist that does not switch the lights
     off. Brightness is held off for long enough for the stragglers to pass. */
  if (!on) {
    state.holdOffUntil = performance.now() + 900;
    rollEnd();
  }

  /* Switching off records the level it was at, so switching back on resumes
     there instead of at some default. */
  if (!on) {
    const live = dimmable().find((d) => d.state === "on");
    if (live) state.memory.pct = live.pct ?? haToPct(live.brightness);
    saveMemory();
  }
  const restore = state.memory;

  try {
    for (const device of devices) {
      const data = {};
      if (on && device.domain === "light") {
        if (device.supportsBrightness) data.brightness = pctToHa(restore.pct);
        if (device.supportsColor) Object.assign(data, tintData(device, COLORS[restore.color], restore.pct));
      }
      await callService(device, on ? "turn_on" : "turn_off", data);
      const patch = { state: on ? "on" : "off" };
      if (on && device.supportsBrightness) { patch.pct = restore.pct; patch.brightness = pctToHa(restore.pct); }
      if (on) patch.tint = COLORS[restore.color].name;
      markDevice(device.entityId, patch);
    }
    if (on) saveMemory();
    quietPoll(); renderDevices();
    if (silent) return;
    const text = on
      ? `${devices.length === 1 ? devices[0].name : "All nodes"} on · ${COLORS[restore.color].name} ${restore.pct}%`
      : `${devices.length === 1 ? devices[0].name : "All nodes"} off`;
    logLine(text); announce(text); toast(text, on ? "warm" : "ok");
  } catch (error) { commandFailed(error); void refreshStates(); }
}

/**
 * Colour only.
 *
 * Brightness is never touched here — not even by white. The level belongs to
 * the room and is shared by all four colours, so 1-2-3-4 recolours the light
 * you already have rather than resetting how bright it is.
 */
async function selectColor(index) {
  const tint = COLORS[index];
  if (!tint) return;
  state.memory.color = index;
  saveMemory();

  /* Only a lit lamp is recoloured; an unlit one just remembers the choice.
     That makes the app's idea of on-and-off load-bearing, so if it believes
     everything is off, check before deciding nothing needs sending — a stale
     "off" is otherwise indistinguishable from a colour command that silently
     did nothing. */
  if (state.mode === "live" && !targetDevices().some((d) => d.state === "on")) {
    await refreshStates();
  }
  const lit = targetDevices().filter((d) => d.supportsColor && d.state === "on");
  quietPoll();
  try {
    const level = currentLevel();
    for (const device of lit) {
      await callService(device, "turn_on", tintData(device, tint, level));
      markDevice(device.entityId, { tint: tint.name, pct: level, brightness: pctToHa(level) });
    }
    quietPoll(); renderDevices();
    const text = lit.length > 0 ? `${tint.name} · ${currentLevel()}%` : `${tint.name} armed`;
    logLine(text); announce(text); toast(text, "ok");
  } catch (error) { commandFailed(error); }
}

/** Brightness only — colour is left exactly where it is. */
async function pushBrightness(devices, pct, { silent = false } = {}) {
  // Just switched off: a late brightness command would undo it.
  if (performance.now() < state.holdOffUntil) return;
  quietPoll();
  state.memory.pct = pct;              // one level, shared by every colour
  saveMemory();
  try {
    for (const device of devices) {
      await callService(device, "turn_on", { brightness: pctToHa(pct) });  // no rgb: colour survives
      markDevice(device.entityId, { pct, brightness: pctToHa(pct), state: "on" });
    }
    quietPoll(); renderDevices();
    if (!silent) { logLine(`Brightness ${pct}%`); announce(`Brightness ${pct} percent`); }
  } catch (error) { commandFailed(error); }
}

/* ------------------------------------------- pinch: the rotation lock */

/**
 * Pinch locks and releases the rotation knob.
 *
 *   one tap   rotation locked on
 *   two taps  rotation released
 *
 * Each tap sets an absolute state rather than toggling one: the first locks,
 * a second inside the double-tap window releases. A double tap therefore
 * lands released from either starting state, and a single tap lands locked
 * from either — so nothing has to be deferred while the code waits to find
 * out which gesture it was. Both answer on the frame the fingers part.
 *
 * The gate exists because rotation used to be bound to holding an open palm,
 * which needed four fingers and an extended thumb recognised on every frame.
 * A thumb that relaxed for a moment dropped the knob mid-turn, and four
 * fingers without the thumb is the white colour command — so the same wobble
 * also recoloured the room. Locking separates the two completely.
 */
function pinchPhase() {
  if (state.hand?.pinching) return "closed";
  if (state.locked) return "locked";
  return "open";
}

const PINCH_WORDS = { open: "open", closed: "pinched", locked: "turning on · open hand to end" };

function setRotationLock(on) {
  if (state.locked === on) return;
  state.locked = on;
  state.rollGapSince = 0;
  if (on) {
    state.roll = null;                       // anchored on the next frame with a hand
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    logLine("Turning locked on");
    announce("Turning locked on. Turn your hand right to brighten, left to dim.");
    toast("Turning locked on", "warm");
  } else {
    const level = state.roll?.active ? Math.round(state.roll.level) : null;
    rollEnd();
    $("lock-fill").style.width = "0%";
    $("lock-status").textContent = "Standby";
    logLine(level === null ? "Turning off" : `Turning off at ${level}%`);
    announce("Turning switched off.");
    toast("Turning off", "ok");
  }
  paintLevelChip();
}

/**
 * The fingertips touching, and parting again — debounced.
 *
 * Both edges need PINCH_STABLE_FRAMES frames of agreement, and a second
 * contact only counts as half of a double pinch if the fingers were properly
 * apart in between. Without that, one flickering frame in the middle of a
 * single deliberate pinch reads as two contacts, which locks and then
 * immediately releases — leaving the operator sure that nothing happened.
 *
 * The release starts the refractory window, during which no pose can fire.
 * That is what stops the hand OPENING out of a pinch, through three and four
 * fingers, from being read as the blue or white colour command on its way.
 */
function pinchEdge(hand, now) {
  /* Re-arming is the important half, and it is deliberately not a timer.

     A pinch "releases" as soon as the gap passes 0.44 palm lengths, and
     counts again below 0.30. Those two numbers are a few millimetres apart,
     and a hand that has just pinched and is now turning keeps its finger and
     thumb right between them — so the lock was flipping on and off by
     itself, which is precisely the rotation that works one moment and not
     the next.

     So a second pinch only counts once the hand has genuinely OPENED: the
     gap has to clear 0.75 palm lengths, well outside the hysteresis band,
     and stay there for a moment. Pinch, turn as long as you like, open your
     hand, pinch again. */
  const gap = hand?.pinchGap ?? 9;
  if (gap > LIMITS.pinchClear) {
    if (!state.clearSince) state.clearSince = now;
    if (now - state.clearSince >= PINCH_CLEAR_MS) state.pinchArmed = true;
  } else {
    state.clearSince = 0;
  }

  const raw = Boolean(hand?.pinching);
  state.pinchRun = raw === state.pinchHeld ? 0 : state.pinchRun + 1;
  if (state.pinchRun < PINCH_STABLE_FRAMES) return;

  state.pinchRun = 0;
  state.pinchHeld = raw;

  if (!raw) {
    state.pinchDown = null;
    state.pinchEndAt = now;
    return;
  }

  if (!state.pinchArmed) return;                        // hand has not opened yet
  if (now - state.pinchEndAt < PINCH_SEPARATE_MS) return;

  state.pinchArmed = false;
  state.clearSince = 0;
  state.pinchDown = { t0: now };
  state.lastTapAt = now;
  state.lastFired = now;
  setRotationLock(!state.locked);
}

/* -------------------------------------------- rotation: the brightness knob */

/**
 * While rotation is locked the hand is a knob and nothing else.
 *
 * It reads the roll of the hand — the lean of the wrist-to-knuckles axis — and
 * is deliberately blind to what the fingers are doing. Any hand shape will
 * turn it, which is the point: the operator can hold their hand however is
 * comfortable and simply rotate, with no pose to maintain and no pose to lose.
 *
 * Relative, not absolute. The knob picks up the level the lights are already
 * at, so locking never moves anything; rolling right raises and left lowers,
 * and rolling back returns the level it started from.
 */
function rollState() {
  if (state.roll?.active) return "live";
  if (state.locked) return "waiting";
  return "idle";
}

/** Mark that the hand has gone, so the knob re-anchors rather than jumping. */
function rollPause(now) {
  if (state.roll && !state.rollGapSince) state.rollGapSince = now;
}

function rollEnd() {
  const was = state.roll;
  state.roll = null;
  state.rollGapSince = 0;
  state.knobSlipSince = 0;
  if (was?.active) {
    $("lockbar").classList.remove("is-armed");
    $("reactor").classList.remove("is-armed");
    logLine(`Brightness ${Math.round(was.level)}%`);
  }
}

/**
 * @param {object} hand
 * @param {number} now
 * @param {boolean} forced  true while the pinch lock is on: the knob is live
 *                          from the first frame, whatever shape the hand is
 *                          in. Otherwise it watches an open palm and takes
 *                          over only once the hand has actually turned.
 */
function rollUpdate(hand, now, forced) {
  const roll = hand.palmRoll;
  const twist = hand.palmTwist;

  if (!state.roll) {
    const level = currentLevel();
    state.roll = {
      roll, twist, last: now, level, delta: 0, lastSend: 0, active: false,
      anchor: { roll, twist, level },
    };
  }
  const knob = state.roll;
  const dt = now - knob.last;
  knob.last = now;

  /* Back after a blink: jump the filters to where the hand actually is and
     re-anchor there at the level reached, so the gap costs nothing and moves
     nothing. Resuming against the angles from before the gap would step the
     lights by however far the hand travelled while it was unseen. */
  if (state.rollGapSince) {
    state.rollGapSince = 0;
    knob.roll = unwrapDeg(knob.roll, roll);
    knob.twist = unwrapDeg(knob.twist, twist);
    knob.anchor = { roll: knob.roll, twist: knob.twist, level: Math.round(knob.level) };
  }

  /* Filter both angles before anything looks at them. unwrapDeg keeps each
     track continuous across the +/-180 seam, so a hand turned past the
     halfway point does not read as a 358-degree flick. */
  const k = ease(dt, ROLL_ANGLE_TAU);
  knob.roll = lerp(knob.roll, unwrapDeg(knob.roll, roll), k);
  knob.twist = lerp(knob.twist, unwrapDeg(knob.twist, twist), k);
  knob.delta = turnDelta(knob.roll, knob.twist, knob.anchor.roll, knob.anchor.twist);

  /* Passive until the hand has really turned. An open palm shown simply to
     switch the lights on must not start moving the brightness, and must not
     start blocking the colour commands either. */
  if (!knob.active) {
    if (!forced && Math.abs(knob.delta) <= ROLL.dead) {
      $("lock-status").textContent = "Turn to dim";
      paintLevelChip();
      return;
    }
    knob.active = true;
    knob.level = currentLevel();
    knob.anchor = { ...knob.anchor, level: knob.level };
    $("lockbar").classList.add("is-armed");
    $("reactor").classList.add("is-armed");
  }

  const target = rollToLevel(knob.anchor.level, knob.delta);

  /* Anti-windup. Once the level is pinned at an end, re-anchor to exactly the
     turn that produces that end — otherwise turning further banks up slack
     that has to be unwound before a reversal does anything. */
  if (target >= 100 || target <= ROLL.floor) {
    knob.anchor.roll = knob.roll - rollAtLevel(knob.anchor.level, target);
    knob.anchor.twist = knob.twist;
  }

  knob.level = lerp(knob.level, target, ease(dt, ROLL_LEVEL_TAU));
  const pct = clamp(Math.round(knob.level), ROLL.floor, 100);
  state.holdProgress = 0;
  $("lock-fill").style.width = `${pct}%`;
  $("lock-status").textContent =
    `${knob.delta > ROLL.dead ? "Brighter" : knob.delta < -ROLL.dead ? "Dimmer" : "Holding"} ${pct}%`;
  paintLevelChip(pct);

  const devices = dimmable();
  if (devices.length === 0) { $("lock-status").textContent = "Not dimmable"; return; }
  if (now < state.holdOffUntil) return;              // just switched off: stay off
  if (state.mode !== "live") $("lock-status").textContent = `Simulation ${pct}%`;
  if (now - knob.lastSend < ROLL_SEND_MS) return;
  if (Math.abs((devices[0].pct ?? -1) - pct) < ROLL_SEND_STEP) return;
  knob.lastSend = now;
  void pushBrightness(devices, pct, { silent: true });
}

/* ------------------------------------------------------- the level read-out */

const LEVEL_NOTES = {
  idle:    "open palm · turn to dim",
  waiting: "pinched on · turn your hand",
  live:    "right brighter · left dimmer",
};

/**
 * The chip on the camera view: the live level, a needle that follows the hand,
 * and the colour code echoed onto the edge of the stage.
 *
 * It is called every frame, so it writes to the DOM only when something it
 * shows has actually changed — the needle excepted, which is a transform and
 * is what makes the gauge feel attached to the hand.
 */
let chipSignature = "";

function paintLevelChip(pct) {
  const phase = rollState();
  const level = pct ?? (state.roll?.active ? Math.round(state.roll.level) : currentLevel());
  const signature = `${phase}|${level}`;
  if (signature !== chipSignature) {
    chipSignature = signature;
    $("dial-chip").dataset.phase = phase;
    $("dial-state").textContent = phase === "live" ? `${level}%` : phase === "idle" ? `${level}%` : `LOCK ${level}%`;
    $("dial-note").textContent = LEVEL_NOTES[phase];
  }
  $("stage").dataset.phase = hudPhase();
  const needle = $("roll-needle");
  const deg = state.roll?.active ? clamp(state.roll.delta, -120, 120) : 0;
  needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
}

/* ----------------------------------------------- thumb up / down ramping */

function thumbRamp(direction, now) {
  const devices = dimmable();
  if (devices.length === 0) { $("lock-status").textContent = "Not dimmable"; return; }

  if (!state.thumb || state.thumb.dir !== direction) {
    state.thumb = { dir: direction, since: now, pct: currentLevel(), lastSend: 0, armed: false, last: now };
  }
  const thumb = state.thumb;

  // Settle first: a thumb merely passing through never reaches the ramp.
  if (!thumb.armed) {
    const progress = (now - thumb.since) / THUMB_ARM_MS;
    $("lock-fill").style.width = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
    $("lock-status").textContent = direction > 0 ? "Arming up" : "Arming down";
    if (progress < 1) { thumb.last = now; return; }
    thumb.armed = true;
    thumb.pct = currentLevel();
    thumb.last = now;
    $("lockbar").classList.add("is-armed");
    $("reactor").classList.add("is-armed");
  }

  const dt = Math.min((now - thumb.last) / 1000, 0.12);
  thumb.last = now;
  thumb.pct = clamp(thumb.pct + direction * RAMP_PCT_PER_SEC * dt, 2, 100);
  const pct = Math.round(thumb.pct);
  $("lock-fill").style.width = `${pct}%`;
  $("lock-status").textContent = `${direction > 0 ? "Rising" : "Falling"} ${pct}%`;

  if (now - thumb.lastSend < RAMP_SEND_MS) return;
  if (Math.abs((devices[0].pct ?? -1) - pct) < 2) return;
  thumb.lastSend = now;
  void pushBrightness(devices, pct, { silent: true });
}

function thumbEnd() {
  if (!state.thumb) return;
  const { armed, pct } = state.thumb;
  state.thumb = null;
  $("lockbar").classList.remove("is-armed");
  $("reactor").classList.remove("is-armed");
  $("lock-fill").style.width = "0%";
  $("lock-status").textContent = "Standby";
  if (armed) { logLine(`Brightness ${Math.round(pct)}%`); announce(`Brightness ${Math.round(pct)} percent`); }
}

/* --------------------------------------------------------------- HUD paint */

const BONES = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12],
  [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17],
];
const TIP_IDS = [4, 8, 12, 16, 20];
const PALM_HULL = [0, 1, 5, 9, 13, 17];

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * The iconic colour code. The same five colours appear on the canvas, on the
 * level chip and in the legend under the protocol, so the colour alone tells
 * you what the system is doing without reading a word of it.
 */
const HUD_ACCENT = {
  track:  "70,220,255",    // cyan — tracking, nothing engaged
  pinch:  "70,240,180",    // jade — fingertips together
  arming: "255,200,120",   // warm — the knob is settling
  roll:   "245,154,35",    // DURO amber — brightness is moving
};

function hudPhase() {
  if (state.roll?.active) return "roll";
  if (state.locked) return "arming";
  if (state.thumb?.armed) return "roll";
  if (state.hand?.pinching) return "pinch";
  return "track";
}

/**
 * Where the camera image actually lands inside the stage.
 *
 * The video is `object-fit: cover`, so unless its aspect ratio happens to
 * match the stage it is scaled up and cropped — and landmark coordinates are
 * fractions of the CAMERA FRAME, not of the element. Painting them straight
 * onto the element box, which is what this did, puts the skeleton somewhere
 * near the hand rather than on it: out by up to an eighth of the height and
 * a third of the scale on a 4:3 camera in a 16:9 frame.
 */
function viewBox(rect) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: rect.width, h: rect.height };
  const scale = Math.max(rect.width / vw, rect.height / vh);     // cover
  const w = vw * scale, h = vh * scale;
  return { x: (rect.width - w) / 2, y: (rect.height - h) / 2, w, h };
}

/** Camera-frame fraction -> canvas pixels. */
const vx = (nx) => state.view.x + nx * state.view.w;
const vy = (ny) => state.view.y + ny * state.view.h;

function sizeCanvas() {
  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

/**
 * Text on a mirrored canvas.
 *
 * The whole overlay is drawn flipped so that it tracks the mirrored video,
 * which would also flip every glyph. Flipping a second time inside this
 * helper puts the type the right way round while leaving it anchored to the
 * mirrored position.
 */
function hudText(text, x, y, { size = 11, weight = 600, fill, align = "center", base = "middle", glow = 0 }) {
  const w = state.rect.width;
  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.font = `${weight} ${size}px ${MONO}`;
  ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = base;
  if (glow) { ctx.shadowColor = fill; ctx.shadowBlur = glow; }
  ctx.fillText(text, w - x, y);
  ctx.restore();
}

function corners(x, y, w, h, color, lw = 2) {
  const arm = clamp(Math.min(w, h) * 0.26, 10, 30);
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * arm, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * arm);
    ctx.stroke();
  }
}

function dashedRing(cx, cy, radius, segments, rotation, color, lw = 1.6) {
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, rotation + i * step, rotation + i * step + step * 0.52);
    ctx.stroke();
  }
}

/** Ticked ring: a machined bezel, long marks at the quarters. */
function tickRing(cx, cy, radius, color, long = "rgba(255,255,255,.5)") {
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 36; i += 1) {
    const a = (i / 36) * Math.PI * 2;
    const major = i % 9 === 0;
    const inner = radius - (major ? 9 : 4.5);
    ctx.strokeStyle = major ? long : color;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
  }
}

/**
 * The palm-roll gauge: the showpiece, and also the only honest read-out of
 * what the knob is doing. The needle lies along the hand itself, the notch
 * marks where the roll was picked up, and the lit arc between them is the
 * brightness that has been added or taken away.
 */
function rollGauge(hand, rgb, radius, now, r_alpha) {
  const knob = state.roll;
  const cx = vx(hand.palm.x);
  const cy = vy(hand.palm.y);
  const axis = hand.palmAxis;                       // camera space: draws correctly mirrored
  const armed = Boolean(knob?.active);
  const delta = armed ? knob.delta : 0;
  const level = armed ? Math.round(knob.level) : currentLevel();

  ctx.strokeStyle = rgb(0.2); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  tickRing(cx, cy, radius, rgb(0.3), rgb(0.75));

  if (armed) {
    const anchor = axis + (delta * Math.PI) / 180;

    // Slack band: inside this the lights deliberately do not move.
    ctx.strokeStyle = rgb(0.3); ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 14, anchor - (ROLL.dead * Math.PI) / 180, anchor + (ROLL.dead * Math.PI) / 180);
    ctx.stroke();

    // Travel: anchor -> now.
    if (Math.abs(delta) > ROLL.dead) {
      ctx.strokeStyle = rgb(0.95); ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.shadowColor = rgb(0.8); ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(cx, cy, radius - 14, anchor, axis, delta > 0);
      ctx.stroke();
      ctx.shadowBlur = 0; ctx.lineCap = "butt";
    }

    // Anchor notch.
    ctx.strokeStyle = rgb(0.85); ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(anchor) * (radius - 22), cy + Math.sin(anchor) * (radius - 22));
    ctx.lineTo(cx + Math.cos(anchor) * (radius - 4), cy + Math.sin(anchor) * (radius - 4));
    ctx.stroke();
  } else {
    // Not engaged yet: a slow orbit, so the gauge reads as waiting, not dead.
    dashedRing(cx, cy, radius - 14, 12, now / 2200, rgb(0.3));
  }

  // The needle, lying along the hand.
  const nx = cx + Math.cos(axis) * (radius + 4);
  const ny = cy + Math.sin(axis) * (radius + 4);
  ctx.strokeStyle = rgb(armed ? 1 : 0.5); ctx.lineWidth = armed ? 2.6 : 1.6;
  ctx.shadowColor = rgb(0.7); ctx.shadowBlur = armed ? 12 : 0;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgb(armed ? 1 : 0.6);
  ctx.beginPath(); ctx.arc(nx, ny, armed ? 4.5 : 3, 0, Math.PI * 2); ctx.fill();

  /* The read-out sits in the middle of the hand, where the eye already is —
     but that is also where the skeleton is busiest, so it gets a dark disc to
     sit on. Without it the number is unreadable against a pale palm. */
  ctx.fillStyle = `rgba(3,9,16,${0.74 * r_alpha()})`;
  ctx.beginPath(); ctx.arc(cx, cy, 35, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgb(armed ? 0.75 : 0.4); ctx.lineWidth = armed ? 1.6 : 1;
  ctx.beginPath(); ctx.arc(cx, cy, 35, 0, Math.PI * 2); ctx.stroke();
  hudText(`${level}%`, cx, cy - 6, { size: 22, weight: 700, fill: rgb(1), glow: armed ? 14 : 0 });
  hudText(
    armed ? `${delta >= 0 ? "+" : ""}${Math.round(delta)}° TURN` : "TURN TO DIM",
    cx, cy + 15, { size: 8, weight: 600, fill: rgb(0.72) },
  );
}

/** The vertical brightness column beside the reticle. */
function levelColumn(x, top, height, rgb, level) {
  ctx.strokeStyle = rgb(0.3); ctx.lineWidth = 1;
  ctx.strokeRect(x, top, 8, height);
  for (let i = 1; i < 4; i += 1) {
    const y = top + (height * i) / 4;
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x, y); ctx.stroke();
  }
  const fill = (clamp(level, 0, 100) / 100) * (height - 2);
  const grad = ctx.createLinearGradient(0, top + height, 0, top);
  grad.addColorStop(0, rgb(0.35));
  grad.addColorStop(1, rgb(1));
  ctx.fillStyle = grad;
  ctx.fillRect(x + 1, top + height - 1 - fill, 6, fill);
  ctx.fillStyle = rgb(1);
  ctx.fillRect(x - 2, top + height - 1 - fill - 1, 12, 2);
}

function paint(rect, now) {
  state.rect = rect;
  state.view = viewBox(rect);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const hand = state.hand;

  const want = hand
    ? { x: vx(hand.box.minX), y: vy(hand.box.minY),
        w: (hand.box.maxX - hand.box.minX) * state.view.w,
        h: (hand.box.maxY - hand.box.minY) * state.view.h, a: 1 }
    : { ...(state.reticle ?? { x: 0, y: 0, w: 0, h: 0 }), a: 0 };
  if (!state.reticle) state.reticle = want;
  const r = state.reticle;
  const k = hand ? 0.38 : 0.14;
  r.x = lerp(r.x, want.x, k); r.y = lerp(r.y, want.y, k);
  r.w = lerp(r.w, want.w, k); r.h = lerp(r.h, want.h, k);
  r.a = lerp(r.a, want.a, 0.22);
  if (r.a < 0.02) return;

  const phase = hudPhase();
  const accent = HUD_ACCENT[phase];
  const rgb = (alpha) => `rgba(${accent},${alpha * r.a})`;
  const lit = anyOn();
  const tint = activeTint().rgb;

  ctx.save();
  ctx.translate(rect.width, 0); ctx.scale(-1, 1);
  ctx.lineJoin = "round";

  const pad = 20;
  const bx = r.x - pad, by = r.y - pad, bw = r.w + pad * 2, bh = r.h + pad * 2;
  const cx = hand ? vx(hand.palm.x) : r.x + r.w / 2;
  const cy = hand ? vy(hand.palm.y) : r.y + r.h / 2;

  /* The colour the room is actually lit in, bloomed behind the hand. It makes
     the overlay feel connected to the lights rather than painted on top. */
  if (lit) {
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bw, bh) * 0.95);
    halo.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${0.16 * r.a})`);
    halo.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, rect.width, rect.height);
  }

  // Rails out to the edges, with a tick ladder along each.
  ctx.strokeStyle = rgb(0.16); ctx.lineWidth = 1; ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(0, by + bh / 2); ctx.lineTo(bx, by + bh / 2);
  ctx.moveTo(bx + bw, by + bh / 2); ctx.lineTo(rect.width, by + bh / 2);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = rgb(0.22);
  for (let i = 0; i < 7; i += 1) {
    const t = (i + 1) / 8;
    const yy = by + bh / 2;
    const lxx = bx * t, rxx = bx + bw + (rect.width - bx - bw) * t;
    const len = i % 2 ? 3 : 6;
    ctx.beginPath(); ctx.moveTo(lxx, yy - len); ctx.lineTo(lxx, yy + len);
    ctx.moveTo(rxx, yy - len); ctx.lineTo(rxx, yy + len);
    ctx.stroke();
  }

  ctx.shadowColor = rgb(0.5); ctx.shadowBlur = 8;
  corners(bx, by, bw, bh, rgb(0.9));
  ctx.shadowBlur = 0;

  if (hand) {
    // Holographic plate over the palm, so the hand reads as a solid object.
    ctx.beginPath();
    PALM_HULL.forEach((id, i) => {
      const p = hand.landmarks[id];
      if (i === 0) ctx.moveTo(vx(p.x), vy(p.y)); else ctx.lineTo(vx(p.x), vy(p.y));
    });
    ctx.closePath();
    ctx.fillStyle = rgb(0.1);
    ctx.fill();
    ctx.strokeStyle = rgb(0.3); ctx.lineWidth = 1; ctx.stroke();

    // Skeleton in two passes: a wide soft pass for the bloom, then a crisp core.
    for (const [width, alpha, blur] of [[7, 0.18, 0], [2.4, 0.9, 10]]) {
      ctx.strokeStyle = rgb(alpha); ctx.lineWidth = width; ctx.lineCap = "round";
      ctx.shadowColor = rgb(0.55); ctx.shadowBlur = blur;
      for (const chain of BONES) {
        ctx.beginPath();
        chain.forEach((id, i) => {
          const p = hand.landmarks[id];
          if (i === 0) ctx.moveTo(vx(p.x), vy(p.y)); else ctx.lineTo(vx(p.x), vy(p.y));
        });
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = rgb(0.75);
    for (let id = 0; id < 21; id += 1) {
      if (TIP_IDS.includes(id)) continue;
      const p = hand.landmarks[id];
      ctx.beginPath(); ctx.arc(vx(p.x), vy(p.y), 2.4, 0, Math.PI * 2); ctx.fill();
    }

    const extended = [hand.thumbExtended, ...hand.up];
    TIP_IDS.forEach((id, i) => {
      const p = hand.landmarks[id];
      const x = vx(p.x), y = vy(p.y);
      const live = extended[i];
      ctx.shadowColor = rgb(0.6); ctx.shadowBlur = live ? 12 : 0;
      ctx.fillStyle = live ? `rgba(255,255,255,${r.a})` : rgb(0.4);
      ctx.beginPath(); ctx.arc(x, y, live ? 5 : 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (live) {
        ctx.strokeStyle = rgb(0.7); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        // A slow counter-rotating tick on each live tip.
        dashedRing(x, y, 13, 4, now / 900 + i, rgb(0.35), 1);
      }
    });

    /* The pinch read-out, always on: the measured gap between index and thumb
       on a 0-100 scale, printed between the fingertips. Seeing the number is
       what makes a pinch repeatable — you can watch it close before the tap
       registers rather than guessing what the camera thinks. */
    const t = hand.landmarks[4], ix = hand.landmarks[8];
    const tx = vx(t.x), ty = vy(t.y);
    const nx = vx(ix.x), ny = vy(ix.y);
    const mx = (tx + nx) / 2, my = (ty + ny) / 2;
    const closed = hand.pinching;
    const gap = gapToLevel(hand.pinchGap, 0);
    const pinchRgb = (a) => closed
      ? `rgba(${HUD_ACCENT.pinch},${a * r.a})`
      : rgb(a);

    ctx.strokeStyle = pinchRgb(closed ? 1 : 0.45);
    ctx.lineWidth = closed ? 2.8 : 1.3;
    ctx.setLineDash(closed ? [] : [3, 5]);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.setLineDash([]);

    // End caps, so the measured span is unmistakable.
    const ang = Math.atan2(ny - ty, nx - tx) + Math.PI / 2;
    ctx.lineWidth = closed ? 2.4 : 1.2;
    for (const [px, py] of [[tx, ty], [nx, ny]]) {
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(ang) * 5, py + Math.sin(ang) * 5);
      ctx.lineTo(px - Math.cos(ang) * 5, py - Math.sin(ang) * 5);
      ctx.stroke();
    }

    ctx.fillStyle = pinchRgb(closed ? 0.3 : 0.14);
    ctx.shadowColor = pinchRgb(0.8); ctx.shadowBlur = closed ? 16 : 0;
    ctx.beginPath(); ctx.arc(mx, my, closed ? 16 : 13, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = pinchRgb(0.8); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(mx, my, closed ? 16 : 13, 0, Math.PI * 2); ctx.stroke();
    hudText(String(gap), mx, my, { size: 12, weight: 700, fill: pinchRgb(1), glow: closed ? 10 : 0 });
    hudText(closed ? "PINCHED" : "GAP", mx, my + (closed ? 28 : 25), { size: 8, weight: 600, fill: pinchRgb(0.75) });

    // A tap ripple, so a registered tap is visibly acknowledged.
    const sinceTap = now - state.lastTapAt;
    if (state.lastTapAt && sinceTap < 420) {
      const grow = sinceTap / 420;
      ctx.strokeStyle = `rgba(${HUD_ACCENT.pinch},${(1 - grow) * r.a})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mx, my, 16 + grow * 34, 0, Math.PI * 2); ctx.stroke();
    }

    // Palm rings, hold progress, and the roll gauge when a palm is in play.
    /* The gauge is always drawn, locked or not. The level in the middle of
       the hand is the read-out worth having, and hiding it until rotation is
       locked took away the one number the operator actually watches. */
    const gaugeR = clamp(Math.min(bw, bh) * 0.42, 52, 94);
    const knobVisible = true;
    if (knobVisible) {
      rollGauge(hand, rgb, gaugeR, now, () => r.a);
    } else {
      dashedRing(cx, cy, 30, 10, now / 2600, rgb(0.45));
      dashedRing(cx, cy, 39, 6, -now / 3400, rgb(0.22));
    }

    if (state.holdProgress > 0.02 && !state.locked) {
      const hr = knobVisible ? gaugeR + 10 : 46;
      ctx.strokeStyle = rgb(1); ctx.lineWidth = 3.2; ctx.lineCap = "round";
      ctx.shadowColor = rgb(0.7); ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, hr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * state.holdProgress);
      ctx.stroke(); ctx.shadowBlur = 0; ctx.lineCap = "butt";
    }

    if (lit || state.roll?.active || state.thumb?.armed) {
      const level = state.roll?.active ? state.roll.level : (state.thumb?.armed ? state.thumb.pct : currentLevel());
      levelColumn(bx - 24, by + 8, Math.max(46, bh - 16), rgb, level);
    }
  }

  // Labels sit outside the mirrored geometry but share its anchor points.
  hudText(state.intent.label ?? "", bx + bw, by - 10,
    { size: 12, weight: 700, fill: rgb(0.95), align: "left", base: "bottom" });
  if (hand) {
    hudText(`${hand.count} UP · GAP ${gapToLevel(hand.pinchGap, 0)} · ROLL ${Math.round(hand.palmRoll)}°`,
      bx + bw, by + bh + 8, { size: 10, weight: 400, fill: rgb(0.62), align: "left", base: "top" });
  }
  ctx.restore();
}

/* ------------------------------------------------- lighting compensation */

/* A 32x24 probe is enough to judge exposure and colour cast, and costs
   almost nothing to read back. */
const probe = document.createElement("canvas");
probe.width = 32; probe.height = 24;
const probeCtx = probe.getContext("2d", { willReadFrequently: true });

function measureFrame() {
  try {
    probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
    const { data } = probeCtx.getImageData(0, 0, probe.width, probe.height);
    let luma = 0, sat = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
    const n = data.length / 4;
    return { luma: luma / n, sat: sat / n };
  } catch {
    return state.probe;                       // tainted or not ready yet
  }
}

/**
 * Turn a measurement into a CSS filter. Dark rooms get exposure and contrast;
 * strongly coloured rooms get the cast pulled out, because the model reads
 * shape far better than it reads a red-on-red silhouette. `boost` is the
 * extra push applied when tracking is lost despite the correction.
 */
function buildFilter({ luma, sat }, boost) {
  const parts = [];
  const words = [];

  if (luma < LUMA_DARK) {
    const gain = clamp((LUMA_TARGET / Math.max(luma, 10)) * (1 + boost * 0.18), 1, 3.2);
    parts.push(`brightness(${gain.toFixed(2)})`);
    parts.push(`contrast(${(1 + Math.min((LUMA_DARK - luma) / LUMA_DARK, 1) * 0.4).toFixed(2)})`);
    words.push(`dark ${gain.toFixed(1)}x`);
  } else if (luma > LUMA_HOT) {
    parts.push(`brightness(${(LUMA_HOT / luma).toFixed(2)})`);
    words.push("bright");
  }

  if (sat > SAT_CAST) {
    const amount = clamp(1 - (sat - SAT_CAST) * (1.7 + boost * 0.5), 0.12, 1);
    parts.push(`saturate(${amount.toFixed(2)})`);
    if (!parts.some((p) => p.startsWith("contrast"))) parts.push("contrast(1.18)");
    words.push(`cast -${Math.round((1 - amount) * 100)}%`);
  }

  if (boost >= 2 && !parts.some((p) => p.startsWith("grayscale"))) {
    parts.unshift("grayscale(1)");
    words.push("mono");
  }

  return { filter: parts.join(" "), label: words.length ? words.join(" · ") : "Direct" };
}

/** The frame handed to the model: the camera itself, or a corrected copy. */
function detectionSource() {
  if (!state.filter) return video;
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return video;
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  workCtx.filter = state.filter;
  workCtx.drawImage(video, 0, 0, w, h);
  workCtx.filter = "none";
  return work;
}

function updateAssist(found) {
  if (found) {
    state.lostFrames = 0;
    state.goodFrames += 1;
    if (state.boost > 0 && state.goodFrames > BOOST_OK_FRAMES) { state.boost -= 1; state.goodFrames = 0; }
  } else {
    state.goodFrames = 0;
    state.lostFrames += 1;
    if (state.lostFrames > BOOST_LOST_FRAMES && state.boost < 3) { state.boost += 1; state.lostFrames = 0; }
  }

  /* Really struggling: let the model accept weaker evidence. Changing options
     rebuilds the MediaPipe graph and costs a few frames, so it is gated on a
     firm signal and rate-limited — a setting that flapped would stutter far
     worse than the problem it is trying to fix. */
  const wantLowConf = state.boost >= 2;
  if (wantLowConf !== state.lowConf && state.landmarker &&
      performance.now() - state.confChangedAt > CONF_COOLDOWN_MS) {
    state.lowConf = wantLowConf;
    state.confChangedAt = performance.now();
    try { state.landmarker.setOptions(wantLowConf ? LOW_CONF : HIGH_CONF); } catch { /* older build */ }
    logLine(wantLowConf ? "Optics: sensitivity raised" : "Optics: sensitivity normal");
  }

  if (state.probeTick++ % PROBE_EVERY !== 0) return;
  state.probe = measureFrame();
  const { filter, label } = buildFilter(state.probe, state.boost);
  if (filter !== state.filter) {
    state.filter = filter;
    state.assistLabel = label;
    $("assist-val").textContent = label === "Direct" ? "Direct" : "Assisted";
    $("assist-sub").textContent = label === "Direct" ? "none" : label;
  }
}

/* -------------------------------------------------------------- main loop */

const TIPS_REL = [4, 8, 12, 16, 20];

function measureFlux(hand, now) {
  if (!hand) { state.lastTips = null; state.handFlux = 0; return; }
  const points = hand.landmarks;
  const scale = Math.hypot(points[9].x - points[0].x, points[9].y - points[0].y) || 0.1;
  const tips = TIPS_REL.map((id) => ({
    x: (points[id].x - hand.palm.x) / scale,
    y: (points[id].y - hand.palm.y) / scale,
  }));
  if (state.lastTips) {
    const dt = Math.max(now - state.lastTipsAt, 1) / 1000;
    let moved = 0;
    for (let i = 0; i < tips.length; i += 1) {
      moved += Math.hypot(tips[i].x - state.lastTips[i].x, tips[i].y - state.lastTips[i].y);
    }
    state.handFlux = lerp(state.handFlux, moved / tips.length / dt, 0.45);
  }
  state.lastTips = tips;
  state.lastTipsAt = now;
}

function renderPips(hand) {
  const flags = hand ? [hand.thumbExtended, ...hand.up] : [false, false, false, false, false];
  const pips = $("pips").children;
  for (let i = 0; i < pips.length; i += 1) pips[i].classList.toggle("up", Boolean(flags[i]));
}

function highlight(key) {
  for (const node of document.querySelectorAll(".proto")) {
    node.classList.toggle("is-active", node.dataset.id === key);
  }
}

function tick() {
  state.frame = requestAnimationFrame(tick);
  const now = performance.now();
  state.lastTick = now;
  if (!state.landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  if (video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    let result;
    try { result = state.landmarker.detectForVideo(detectionSource(), now); }
    catch (error) { console.error("Tracking fault:", error); stopCamera(); toast("Tracking fault", "bad"); return; }

    state.fpsFrames += 1;
    if (now - state.fpsStamp >= 1000) {
      state.fps = state.fpsFrames; state.fpsFrames = 0; state.fpsStamp = now;
      $("fps-label").textContent = `${state.fps} fps · ${state.hand ? "lock" : "searching"}`;
    }

    const landmarks = result.landmarks?.[0];
    state.hand = landmarks ? analyseHand(landmarks, result.worldLandmarks?.[0], state.prevHand) : null;
    state.prevHand = state.hand;
    state.intent = classify(state.hand);

    state.votes.push(state.hand ? intentKey(state.intent) : "none");
    if (state.votes.length > VOTE_WINDOW) state.votes.shift();
    state.stable = majority(state.votes, VOTE_WINDOW, VOTE_AGREE);

    /* How fast the hand is changing SHAPE, smoothed: the mean travel of the
       five fingertips relative to the palm, in palm lengths per second.

       Measuring how fast the hand moves across the frame — which is what this
       did first — was the wrong thing entirely. Opening a fist into a palm
       barely moves the palm at all, so it sailed past, while simply carrying
       a perfectly good pose across the frame was blocked. The fingers are
       what is in transit, so the fingers are what is measured. */
    measureFlux(state.hand, now);

    /* How long the hand has been showing this many fingers. Reset by every
       change, so it cannot run while a hand is opening or closing. */
    const shown = state.hand ? state.hand.count : -1;
    if (shown !== state.fingerCount) { state.fingerCount = shown; state.countSince = now; }

    updateAssist(Boolean(state.hand));

    renderPips(state.hand);
    $("gesture-name").textContent = state.hand ? (state.intent.label ?? "—") : "No hand";
    $("gesture-detail").textContent = state.hand ? (state.intent.detail ?? "") : "Show your hand to the camera";
    $("pinch-val").textContent = state.hand ? String(gapToLevel(state.hand.pinchGap, 0)) : "—";
    $("pinch-state").textContent = PINCH_WORDS[pinchPhase()];
    $("roll-val").textContent = state.hand
      ? `${Math.round(state.hand.palmRoll)}° / ${Math.round(state.hand.palmTwist)}°`
      : "—";

    act(now);
    paintLevelChip();
    $("roll-sub").textContent = state.roll?.active
      ? `turning · ${Math.round(state.roll.level)}%`
      : state.locked ? "pinched on · turn it" : "tilt or twist it";
  }

  paint(sizeCanvas(), now);
}

/**
 * One pose, one job.
 *
 * Pinch edges run on raw frames so the power switch feels immediate.
 * Everything else waits for the vote to settle and then for a hold, which is
 * what keeps a hand passing through a shape from firing anything.
 */
function holdFor(key, need, now, label, fire) {
  if (state.firedKey === key) { state.holdProgress = 1; $("lock-status").textContent = "Done"; return; }
  if (now - state.lastFired < REPEAT_MS) { $("lock-status").textContent = "Cooldown"; return; }
  if (state.holdKey !== key) { state.holdKey = key; state.holdSince = now; }
  const held = now - state.holdSince;
  state.holdProgress = clamp(held / need, 0, 1);
  $("lock-fill").style.width = `${Math.round(state.holdProgress * 100)}%`;
  $("lock-status").textContent = label;
  if (held < need) return;
  state.firedKey = key;
  state.lastFired = now;
  state.holdProgress = 1;
  fire();
}

function act(now) {
  const hand = state.hand;

  // Pinch edges are watched on every frame: they lock and release rotation.
  pinchEdge(hand, now);

  if (!hand) {
    if (!state.handLostAt) state.handLostAt = now;
    thumbEnd();
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    if (state.locked) {
      rollPause(now);
      $("lock-status").textContent = "Locked · no hand";
      if (now - state.handLostAt > ROLL_RELEASE_MS) setRotationLock(false);
      return;
    }
    rollEnd();
    $("lock-fill").style.width = "0%";
    $("lock-status").textContent = "No hand";
    return;
  }
  state.handLostAt = 0;

  const stable = state.stable;

  /* A closed hand is the escape hatch and it answers from anywhere — locked,
     mid-turn, pinched, it does not matter. Nothing in this app is allowed to
     leave someone unable to switch their own lights off. */
  if (stable === "fist") {
    thumbEnd();
    highlight("fist");
    holdFor("fist", HOLD_MS.fist, now, "All off", () => {
      if (state.locked) setRotationLock(false);
      rollEnd();
      void setPower(false);
    });
    return;
  }

  /* Locked: any hand shape turns the knob. */
  if (state.locked) {
    thumbEnd();
    state.knobSlipSince = 0;
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    const delta = state.roll?.delta ?? 0;
    highlight(delta > ROLL.dead ? "roll_right" : delta < -ROLL.dead ? "roll_left" : "pinch");
    rollUpdate(hand, now, true);
    return;
  }

  /* Fingertips together, on this very frame — not on the settled vote. A hand
     holding a pinch must never reach the pose machine, however the fingers
     happen to be arranged behind it. */
  if (hand.pinching) {
    thumbEnd();
    highlight("pinch");
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    $("lock-fill").style.width = "0%";
    $("lock-status").textContent = "Pinched";
    return;
  }

  if (stable === null) return;            // unsettled: hold whatever we had

  /* An open palm switches the lights on, and the same palm is the brightness
     knob: turn it and the knob takes over. No lock, no ceremony — the lock is
     only needed to turn the knob with the hand in some other shape. */
  if (stable === "palm") {
    thumbEnd();
    state.knobSlipSince = 0;
    rollUpdate(hand, now, false);
    if (state.roll?.active) {
      const delta = state.roll.delta;
      highlight(delta > ROLL.dead ? "roll_right" : delta < -ROLL.dead ? "roll_left" : "palm");
      return;
    }
    highlight("palm");
    holdFor("palm", HOLD_MS.palm, now, "Lights on", () => void setPower(true));
    return;
  }

  /* The knob was turning and the pose slipped — a thumb dropping out of an
     open palm, a frame of bad tracking. Keep turning through it rather than
     handing the hand back to the pose machine, which is where the white
     colour command is waiting. */
  if (state.roll?.active) {
    if (!state.knobSlipSince) state.knobSlipSince = now;
    if (now - state.knobSlipSince < KNOB_HOLD_MS) {
      const before = Math.round(state.roll.level);
      rollUpdate(hand, now, true);
      // Still turning? Then the hand is still the operator's knob, and the
      // window starts again. It only lets go once the turning has stopped.
      if (Math.round(state.roll.level) !== before) state.knobSlipSince = now;
      return;
    }
    rollEnd();
    state.knobSlipSince = 0;
  }

  /* Just out of a pinch: the hand is still unfolding, and the shapes it
     passes through on the way are commands. Sit the moment out. */
  if (now - state.pinchEndAt < PINCH_REFRACTORY_MS) {
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    $("lock-status").textContent = "Pinch released";
    return;
  }

  if (stable === "thumb_up" || stable === "thumb_down") {
    highlight(stable);
    state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
    thumbRamp(stable === "thumb_up" ? 1 : -1, now);
    return;
  }
  thumbEnd();

  if (stable.startsWith("color:")) {
    const index = Number(stable.split(":")[1]);
    highlight(stable);

    const settle = index === 3 ? WHITE_SETTLE_MS : COLOR_SETTLE_MS;
    const settled = now - state.countSince;
    const blocked =
      settled < settle ? "Settling"
      : (COLOR_UNANIMOUS && !state.votes.every((vote) => vote === stable)) ? "Hold steady"
      : state.handFlux > FINGER_STILL ? "Hold still"
      : "";
    if (blocked) {
      state.holdKey = null; state.holdProgress = 0;
      $("lock-fill").style.width = `${Math.round(clamp(settled / settle, 0, 1) * 100)}%`;
      $("lock-status").textContent = `${blocked} · ${COLORS[index].name}`;
      return;
    }

    holdFor(stable, HOLD_MS.color, now, COLORS[index].name, () => void selectColor(index));
    return;
  }

  // Pinch held, or a pose with no meaning: nothing to hold, nothing to fire.
  highlight(stable === "pinch" ? "pinch" : "");
  state.holdKey = null; state.firedKey = null; state.holdProgress = 0;
  $("lock-fill").style.width = "0%";
  $("lock-status").textContent = "Standby";
}

/* ------------------------------------------------------------------ camera */

async function startCamera() {
  const button = $("start-camera");
  const label = button.querySelector("span");
  button.disabled = true; label.textContent = "Starting…";
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera needs localhost or HTTPS.");
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = state.stream;
    await video.play();

    if (!state.landmarker) {
      label.textContent = "Loading model…";
      const { FilesetResolver, HandLandmarker } = await import(`${VENDOR}/vision_bundle.mjs`);
      const vision = await FilesetResolver.forVisionTasks(`${VENDOR}/wasm`);
      state.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${VENDOR}/hand_landmarker.task`, delegate: "GPU" },
        runningMode: "VIDEO", numHands: 1,
        minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.65, minTrackingConfidence: 0.65,
      });
    }

    video.style.display = "block";
    $("stage-idle").hidden = true;
    $("stage-live").hidden = false;
    state.lastVideoTime = -1; state.fpsStamp = performance.now();
    state.frame = requestAnimationFrame(tick);
    logLine("Optics engaged"); announce("Optics engaged.");
  } catch (error) {
    stopCamera();
    const message = error.name === "NotAllowedError" ? "Camera permission denied."
      : error.name === "NotFoundError" ? "No camera found." : error.message;
    toast(message, "bad"); announce(message);
    console.error("Could not start optics:", error);
  } finally {
    button.disabled = false; label.textContent = "Engage optics";
  }
}

function stopCamera() {
  cancelAnimationFrame(state.frame);
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  video.style.display = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("stage-idle").hidden = false;
  $("stage-live").hidden = true;
  $("fps-label").textContent = "Standby";
  $("gesture-name").textContent = "No hand";
  $("gesture-detail").textContent = "Show your hand to the camera";
  $("pinch-val").textContent = "—";
  state.hand = null; state.prevHand = null; state.reticle = null;
  state.handFlux = 0; state.lastTips = null; state.fingerCount = -1;
  state.votes.length = 0; state.stable = null; state.holdProgress = 0;
  state.firedKey = null; state.holdKey = null; state.pinchDown = null;
  state.thumb = null; state.handLostAt = 0;
  state.locked = false; state.roll = null; state.rollGapSince = 0; state.holdOffUntil = 0;
  state.knobSlipSince = 0; state.pinchRun = 0; state.pinchHeld = false;
  state.pinchArmed = true; state.clearSince = 0;
  state.lastTapAt = 0; state.pinchEndAt = 0;
  paintLevelChip();
  state.boost = 0; state.lostFrames = 0; state.goodFrames = 0;
  state.filter = ""; state.assistLabel = "Direct"; state.lowConf = false; state.confChangedAt = 0;
  $("assist-val").textContent = "Direct";
  $("assist-sub").textContent = "none";
  $("pinch-state").textContent = "open";
  $("roll-val").textContent = "—";
  $("roll-sub").textContent = "no hand";
  $("lockbar").classList.remove("is-armed");
  $("reactor").classList.remove("is-armed");
  renderPips(null); highlight("");
  $("lock-fill").style.width = "0%";
  $("lock-status").textContent = "Standby";
}

/* --------------------------------------------------------------- rendering */

const DEVICE_ICON = {
  light: '<path d="M9 21h6M10 18h4M12 3a6 6 0 0 1 4 10.5c-.7.7-1 1.5-1 2.5H9c0-1-.3-1.8-1-2.5A6 6 0 0 1 12 3Z"/>',
  fan: '<circle cx="12" cy="12" r="2.2"/><path d="M12 10c0-3 .6-6 2.5-6S17 7 14 10M14 12c3 0 6 .6 6 2.5S17 17 14 14M12 14c0 3-.6 6-2.5 6S7 17 10 14M10 12c-3 0-6-.6-6-2.5S7 7 10 10"/>',
  switch: '<rect x="3" y="7" width="18" height="10" rx="1"/><circle cx="16" cy="12" r="2.4"/>',
};
DEVICE_ICON.input_boolean = DEVICE_ICON.switch;
DEVICE_ICON.demo = DEVICE_ICON.light;

function renderDevices() {
  const list = $("device-list");
  $("empty-state").hidden = state.devices.length > 0;
  list.hidden = state.devices.length === 0;
  $("target-row").hidden = state.devices.length === 0;
  const on = state.devices.filter((d) => d.state === "on").length;
  $("device-count").textContent = `${on} / ${state.devices.length}`;

  /* Bleed the active colour into the interface, so the console reads as part
     of the room rather than a window onto it. */
  document.body.classList.toggle("is-lit", on > 0);
  document.documentElement.style.setProperty("--tint", activeTint().hex);

  /* The level chip is normally repainted by the tracking loop, which only
     runs while the camera is on. Repaint it here too, or it sits showing
     whatever the level was at page load. */
  paintLevelChip();

  list.replaceChildren(...state.devices.map((device) => {
    const isOn = device.state === "on";
    /* Home Assistant reports no brightness while a light is off, so fall back
       to the level it will come back on at rather than showing a bare 100%. */
    const pct = isOn
      ? (device.pct ?? haToPct(device.brightness))
      : (device.pct ?? state.memory.pct);
    const card = document.createElement("article");
    card.className = `device${isOn ? " is-on" : ""}${device.available ? "" : " is-offline"}`;

    const top = document.createElement("div");
    top.className = "device-top";
    const icon = document.createElement("div");
    icon.className = "device-icon";
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DEVICE_ICON[device.domain] ?? DEVICE_ICON.switch}</svg>`;
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "device-name"; name.textContent = device.name;
    const sub = document.createElement("div");
    sub.className = "device-sub";
    sub.textContent = !device.available ? "Offline"
      : isOn ? (device.supportsBrightness ? `Active · ${pct}% · ${device.tint ?? activeTint().name}` : "Active")
      : `Standby · resumes ${state.memory.pct}%`;
    text.append(name, sub);
    const toggle = document.createElement("button");
    toggle.className = "switch"; toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(isOn));
    toggle.setAttribute("aria-label", `${device.name}, ${isOn ? "on" : "off"}`);
    toggle.disabled = !device.available;
    toggle.addEventListener("click", () => void setPower(!isOn, [device]));
    top.append(icon, text, toggle);
    card.append(top);

    const extras = document.createElement("div");
    extras.className = "device-extras";

    if (device.supportsColor) {
      const swatches = document.createElement("div");
      swatches.className = "swatches";
      COLORS.forEach((color, index) => {
        const swatch = document.createElement("button");
        swatch.className = "swatch"; swatch.type = "button";
        swatch.style.color = color.ui ?? color.hex;   // the dot stays true
        swatch.title = `${color.name} — ${index + 1} finger${index ? "s" : ""}`;
        swatch.setAttribute("aria-label", swatch.title);
        swatch.setAttribute("aria-pressed", String(state.memory.color === index));
        swatch.innerHTML = `<b>${index + 1}</b><i style="background:${color.hex};box-shadow:0 0 10px ${color.hex}"></i>`;
        swatch.addEventListener("click", () => { state.target = device.entityId; renderTargets(); void selectColor(index); });
        swatches.append(swatch);
      });
      extras.append(swatches);
    }

    if (device.supportsBrightness) {
      const row = document.createElement("div");
      row.className = "bright-row";
      const label = document.createElement("span");
      label.className = "tele-key"; label.textContent = "Lvl";
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = "2"; slider.max = "100"; slider.step = "1";
      slider.value = String(pct);
      slider.style.setProperty("--fill", `${pct}%`);
      slider.disabled = !device.available;
      slider.setAttribute("aria-label", `${device.name} brightness`);
      const output = document.createElement("output");
      output.textContent = `${pct}%`;
      slider.addEventListener("input", () => {
        state.draggingId = device.entityId;
        output.textContent = `${slider.value}%`;
        slider.style.setProperty("--fill", `${slider.value}%`);
      });
      slider.addEventListener("change", () => { state.draggingId = ""; void pushBrightness([device], Number(slider.value)); });
      row.append(label, slider, output);
      extras.append(row);
    }

    if (extras.childElementCount > 0) card.append(extras);
    return card;
  }));
}

function renderTargets() {
  const row = $("target-chips");
  if (state.devices.length === 0) return void row.replaceChildren();
  const options = state.devices.length === 1
    ? [{ id: "all", label: state.devices[0].name }]
    : [{ id: "all", label: "All nodes" }, ...state.devices.map((d) => ({ id: d.entityId, label: d.name }))];
  if (!options.some((o) => o.id === state.target)) state.target = "all";
  row.replaceChildren(...options.map((option) => {
    const chip = document.createElement("button");
    chip.className = "target-chip"; chip.type = "button";
    chip.textContent = option.label;
    chip.setAttribute("aria-pressed", String(state.target === option.id));
    chip.addEventListener("click", () => { state.target = option.id; renderTargets(); announce(`Target ${option.label}`); });
    return chip;
  }));
}

function renderProtocol() {
  $("protocol").replaceChildren(...PROTOCOL.map((entry) => {
    const tint = entry.color !== undefined ? COLORS[entry.color] : null;
    const accent = tint ? (tint.ui ?? tint.hex) : entry.accent;
    const item = document.createElement("li");
    item.className = "proto";
    item.dataset.id = entry.id;
    item.style.setProperty("--accent", accent);
    const dot = tint
      ? `<span class="proto-dot" style="background:${tint.hex};box-shadow:0 0 12px ${tint.hex}"></span>` : "";
    item.innerHTML =
      `<span class="proto-glyph">${entry.glyph}</span>` +
      `<span class="proto-text"><strong>${entry.label}</strong><span>${entry.detail}</span></span>${dot}`;
    return item;
  }));
}

/* ----------------------------------------------------------------- linking */

function setStep(step) {
  for (const node of document.querySelectorAll(".step")) {
    const index = Number(node.dataset.step);
    node.classList.toggle("is-active", index === step);
    node.classList.toggle("is-done", index < step);
  }
  $("step-1").hidden = step !== 1; $("step-2").hidden = step !== 2; $("step-3").hidden = step !== 3;
}

function setMessage(id, text, tone = "info", hint = "") {
  const node = $(id);
  if (!text) return void (node.hidden = true);
  node.hidden = false; node.dataset.tone = tone;
  node.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = text;
  node.append(strong);
  if (hint) node.append(document.createTextNode(hint));
}

function renderEntityList() {
  const query = $("entity-search").value.trim().toLowerCase();
  const matches = state.entities.filter((e) => !query || e.name.toLowerCase().includes(query) || e.entityId.includes(query));
  const list = $("entity-list");
  if (matches.length === 0) return void (list.innerHTML = '<p class="entity-empty">No nodes match.</p>');
  list.replaceChildren(...matches.map((entity) => {
    const row = document.createElement("label");
    row.className = "entity";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(entity.entityId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (state.selected.size >= 8) { checkbox.checked = false; return void setMessage("devices-message", "Up to eight nodes.", "error"); }
        state.selected.add(entity.entityId);
      } else state.selected.delete(entity.entityId);
      setMessage("devices-message", ""); updateSelectionCount();
    });
    const text = document.createElement("span");
    text.className = "entity-text";
    text.innerHTML = '<span class="entity-name"></span><span class="entity-id"></span>';
    text.querySelector(".entity-name").textContent = entity.name;
    text.querySelector(".entity-id").textContent = entity.entityId;
    const tags = document.createElement("span");
    tags.className = "entity-tags";
    if (entity.state === "on") tags.innerHTML += '<span class="tag on">On</span>';
    if (entity.supportsBrightness) tags.innerHTML += '<span class="tag dim">Dim</span>';
    if (!entity.available) tags.innerHTML += '<span class="tag">Offline</span>';
    row.append(checkbox, text, tags);
    return row;
  }));
}

function updateSelectionCount() {
  $("selection-count").textContent = `${state.selected.size} selected`;
  $("save-devices").disabled = state.selected.size === 0;
}

const suggestDevices = (entities) => entities.filter((e) => e.domain === "light" && e.available).slice(0, 2).map((e) => e.entityId);

async function connectHome() {
  const button = $("connect-ha");
  button.disabled = true; button.textContent = "Linking…";
  setMessage("setup-message", "Contacting Home Assistant…", "busy");
  try {
    const result = await api("/api/ha/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("ha-url").value, token: $("ha-token").value }),
    });
    $("ha-token").value = "";
    $("ha-url").value = result.url;
    localStorage.setItem("sunday.haUrl", result.url);
    state.entities = result.entities;
    state.selected = new Set(result.entityIds?.length ? result.entityIds : suggestDevices(result.entities));
    setMessage("setup-message", "");
    setStep(2); renderEntityList(); updateSelectionCount();
    setMessage("devices-message", `${result.entities.length} nodes detected.`, "ok");
  } catch (error) {
    setMessage("setup-message", error.message, "error", error.hint ? ` ${error.hint}` : "");
    announce(`Link failed. ${error.message}`);
  } finally {
    button.disabled = false; button.textContent = "Authenticate";
  }
}

async function saveDevices() {
  const button = $("save-devices");
  button.disabled = true; button.textContent = "Saving…";
  try {
    const result = await api("/api/ha/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityIds: [...state.selected] }),
    });
    state.mode = "live"; state.pendingPick = false;
    adoptDevices(result.devices);
    refreshStatus(); startPolling();
    const dim = result.devices.filter((d) => d.supportsBrightness).length;
    $("success-summary").textContent = `${result.devices.length} node${result.devices.length === 1 ? "" : "s"} linked` +
      (dim ? `, ${dim} with brightness and colour.` : ", none dimmable.");
    setStep(3); logLine("Home linked");
  } catch (error) {
    setMessage("devices-message", error.message, "error", error.hint ? ` ${error.hint}` : "");
  } finally {
    button.disabled = false; button.textContent = "Confirm";
  }
}

function adoptDevices(devices) {
  state.devices = devices.map((device) => {
    const existing = state.devices.find((d) => d.entityId === device.entityId);
    return {
      ...device,
      pct: device.state === "on" ? haToPct(device.brightness) : existing?.pct,
      tint: existing?.tint,
    };
  });
  // Keep the remembered level in step with what the home actually reports.
  const live = state.devices.find((d) => d.state === "on" && d.supportsBrightness);
  if (live && Number.isFinite(live.pct)) { state.memory.pct = live.pct; saveMemory(); }
  renderTargets(); renderDevices();
}

async function refreshStates() {
  if (state.mode !== "live" || document.hidden) return;
  // Never let a poll answer land on top of a knob that is mid-turn.
  if (Date.now() < state.quietUntil || state.draggingId || state.locked || state.roll?.active) return;
  try {
    const result = await api("/api/ha/states");
    if (!result.connected) return void enterDemo(false);
    adoptDevices(result.devices);
  } catch (error) { console.warn("State refresh failed:", error.message); }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => void refreshStates(), POLL_MS);
}

function enterDemo(fromUser = true) {
  state.mode = "demo";
  clearInterval(state.pollTimer);
  state.devices = [{
    entityId: "demo.light", domain: "demo", name: "Simulated light", state: "off",
    brightness: 200, supportsColor: true, supportsBrightness: true, available: true,
  }];
  state.target = "all";
  renderTargets(); renderDevices(); refreshStatus();
  if (fromUser) logLine("Simulation mode");
}

async function unlink() {
  try { await api("/api/ha/disconnect", { method: "POST" }); }
  catch (error) { console.warn("Unlink failed:", error.message); }
  enterDemo(); setStep(1);
  setMessage("setup-message", "Unlinked. Token cleared from memory.", "ok");
}

async function restore() {
  const saved = localStorage.getItem("sunday.haUrl");
  if (saved) $("ha-url").value = saved;
  try {
    const result = await api("/api/ha/status");
    if (!result.connected) return void enterDemo(false);
    $("ha-url").value = result.url;
    state.entities = result.entities ?? [];
    if (!result.entityIds?.length) {
      state.selected = new Set(suggestDevices(state.entities));
      state.pendingPick = true;
      enterDemo(false);
      setStatus("demo", "Authenticated", "Select which nodes SUNDAY may control.", "info");
      return;
    }
    state.mode = "live";
    state.selected = new Set(result.entityIds);
    adoptDevices(result.devices);
    refreshStatus(); startPolling(); setStep(3);
  } catch (error) {
    enterDemo(false);
    if (error.message.includes("Local server")) setStatus("error", "Server fault", error.hint ?? "", "error");
  }
}

/* ------------------------------------------------------------------ wiring */

function openSetup(step) {
  const target = step ?? (state.mode === "live" ? 3 : state.pendingPick ? 2 : 1);
  if (target === 2) { renderEntityList(); updateSelectionCount(); }
  setStep(target);
  if (!dialog.open) dialog.showModal();
}

$("start-camera").addEventListener("click", () => void startCamera());
$("stop-camera").addEventListener("click", stopCamera);
$("clear-log").addEventListener("click", () => { state.log = []; $("log-list").innerHTML = '<li class="log-empty">Awaiting input</li>'; });
$("open-setup").addEventListener("click", () => openSetup());
$("status-pill").addEventListener("click", () => openSetup());
$("sysline-action").addEventListener("click", () => openSetup(1));
$("empty-connect").addEventListener("click", () => openSetup(1));
$("empty-demo").addEventListener("click", () => enterDemo());
$("close-setup").addEventListener("click", () => dialog.close());
$("connect-ha").addEventListener("click", () => void connectHome());
$("save-devices").addEventListener("click", () => void saveDevices());
$("back-to-1").addEventListener("click", () => setStep(1));
$("change-devices").addEventListener("click", () => { renderEntityList(); updateSelectionCount(); setStep(2); });
$("disconnect-ha").addEventListener("click", () => void unlink());
$("finish-setup").addEventListener("click", () => dialog.close());
$("use-demo").addEventListener("click", () => { enterDemo(); dialog.close(); });
$("entity-search").addEventListener("input", renderEntityList);
for (const id of ["ha-url", "ha-token"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") void connectHome(); });
}
$("toggle-token").addEventListener("click", () => {
  const input = $("ha-token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-token").textContent = show ? "Hide" : "Show";
});

/* Keyboard equivalents for every gesture. */
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || dialog.open) return;
  const node = event.target;
  if (node instanceof HTMLElement && (node.matches("input, textarea, select") || node.isContentEditable)) return;
  const flash = (id) => { highlight(id); setTimeout(() => highlight(""), 450); };
  if (["1", "2", "3", "4"].includes(event.key)) {
    event.preventDefault(); flash(`color:${Number(event.key) - 1}`); void selectColor(Number(event.key) - 1);
  } else if (event.key === "5") {
    event.preventDefault(); flash("palm"); void setPower(true);
  } else if (event.key === "0") {
    event.preventDefault(); flash("fist"); void setPower(false);
  } else if (event.key === " ") {
    event.preventDefault(); flash("pinch"); setRotationLock(!state.locked);
  } else if (event.key === "Enter") {
    event.preventDefault(); flash(anyOn() ? "fist" : "palm"); void setPower(!anyOn());
  } else if (["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft"].includes(event.key)) {
    // Right / up stands in for rolling the palm right, left / down for left.
    event.preventDefault();
    const up = event.key === "ArrowUp" || event.key === "ArrowRight";
    flash(up ? "roll_right" : "roll_left");
    const devices = dimmable();
    if (devices.length === 0) return;
    void pushBrightness(devices, clamp(currentLevel() + (up ? 5 : -5), ROLL.floor, 100));
  }
});

document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshStates(); });
window.addEventListener("pagehide", stopCamera);

setInterval(() => {
  $("clock").textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
}, 1000);

/* --------------------------------------------------------------------- boot */

loadMemory();
renderProtocol();
paintLevelChip();
renderPips(null);
logLine("SUNDAY online");
enterDemo(false);
void restore();
