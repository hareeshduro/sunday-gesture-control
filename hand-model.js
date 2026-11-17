/**
 * SUNDAY — hand geometry.
 * Concept and direction: Hareesh Narayanan.
 *
 * Pure module: no DOM, no side effects, so every rule here is unit-testable.
 *
 * Classification works from joint angles and radial reach, never from
 * screen-space "is the tip above the knuckle", so a rotated, tilted or
 * mirrored hand reads the same. Every boundary is hysteretic: a pose already
 * held survives a borderline frame, which is what stops the readout flickering
 * between two answers while a hand is held still.
 *
 * The one deliberately screen-relative measurement is the palm roll, because
 * rolling the palm is itself a screen-relative act: it is reported in the
 * mirrored frame the operator actually sees, so "right" on screen is "right"
 * to the hand.
 */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Interior angle at point b, in degrees. Uses z when present. */
export function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 === 0 || m2 === 0) return 180;
  return (Math.acos(clamp(dot / (m1 * m2), -1, 1)) * 180) / Math.PI;
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Fold any angle into (-180, 180]. */
export function normaliseDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * The reading of `next` that sits closest to `previous`.
 *
 * Roll is accumulated over time, so the raw angle wrapping from 179 to -179
 * would read as a 358-degree flick and slam the brightness. Unwrapping keeps
 * the track continuous however far the hand turns.
 */
export const unwrapDeg = (previous, next) => next + 360 * Math.round((previous - next) / 360);

/* The thumb is excluded from the finger count: including it makes "two"
   ambiguous between thumb+index and index+middle, and it reads differently on
   each hand. It is reported separately. */
export const FINGERS = [
  { name: "index",  short: "I", joints: [5, 6, 7, 8] },
  { name: "middle", short: "M", joints: [9, 10, 11, 12] },
  { name: "ring",   short: "R", joints: [13, 14, 15, 16] },
  { name: "pinky",  short: "P", joints: [17, 18, 19, 20] },
];

export const LIMITS = {
  extendAngle: 150, holdAngle: 134,       // finger straightness, enter vs stay
  extendReach: 1.14, holdReach: 1.045,    // fingertip reach past its own PIP
  thumbAngle: 138, thumbReach: 1.10,      // thumb straight and reaching out
  pinchClose: 0.30, pinchOpen: 0.44,      // thumb-index gap, fraction of palm
  pinchArch: 0.55, pinchArchHold: 0.47,   // index tip stood off its own knuckle
  thumbGapFloor: 0.45,                    // a thumb pose needs the tips APART
  thumbVertical: 0.40,                    // how decisively the thumb points
  colorGapFloor: 0.50,                    // a colour needs the thumb clear of the index
  pinchClear: 0.75,                       // the hand must open THIS far between pinches
};

/**
 * The brightness knob's response to a turn of the hand.
 *
 *   dead  degrees of slack around the anchor, so a steady hand holds its level
 *   span  degrees of turn, past the slack, that cover the whole 0-100 range
 *   curve how the response is shaped across that span
 *   floor the dimmest the knob will go; lights stay visible rather than off
 *
 * The curve is the part that makes this usable. A straight 1:1 mapping has to
 * choose between being fine enough to land on a number and being coarse
 * enough to reach both ends, and at 80 degrees for the full range it was
 * neither: a small, ordinary wobble of the wrist threw the lights across
 * forty per cent.
 *
 * Raising the normalised turn to a power above 1 gives a knob that barely
 * moves at first and gains authority the further it goes — fine where you
 * need to be fine, quick where you need to cover ground.
 *
 * The span is how far the hand has to turn for the whole range. It has been
 * wrong in both directions more than once: 80 degrees mapped straight threw
 * the lights across the room on a wobble, 110 degrees curved meant wringing
 * the wrist to reach the top, and 75 was still asking for too much. At 60
 * degrees with a gentler curve, ten degrees of turn moves the lights 9% and
 * a 60 degree turn covers the whole range.
 */
export const ROLL = { dead: 5, span: 60, curve: 1.35, floor: 2 };

/**
 * The index-to-thumb gap, as a fraction of palm length, that spans 0-100%
 * brightness. Measured on reference hands: tips touching sits near 0.02, a
 * fully opened span near 1.40. The ends are pulled inside that so the floor
 * and the ceiling are both comfortably reachable without straining.
 */
export const DIAL_SPAN = { min: 0.12, max: 1.10 };

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (v) => Math.hypot(v.x, v.y, v.z);

/**
 * How far the palm has been twisted about the hand's own long axis, in
 * degrees — pronation and supination, the doorknob turn.
 *
 * This is the other thing people mean by "rotate your hand", and it is
 * invisible to the in-plane roll: twisting the palm from facing the camera to
 * facing sideways barely moves the wrist-to-knuckles axis on screen. Reading
 * both means the knob answers whichever way the hand is actually turned.
 *
 * It needs the metric 3D landmarks, since it is an out-of-plane rotation.
 * Only the CHANGE in this angle is ever used, which is what makes it safe to
 * ignore handedness: flipping the hand over flips the palm normal, offsetting
 * the angle by 180°, but the rate and direction of a turn are unaffected.
 *
 * Undefined when the hand points straight at the lens — there is no reference
 * direction perpendicular to the axis then — so the previous value is held
 * rather than letting the knob jump.
 */
const TWIST_MAX_STEP = 30;       // degrees a wrist can plausibly turn in one frame

function measureTwist(world, previous) {
  if (world?.length !== 21) return previous;
  const wrist = world[0];
  const knuckles = {
    x: (world[5].x + world[9].x + world[13].x + world[17].x) / 4,
    y: (world[5].y + world[9].y + world[13].y + world[17].y) / 4,
    z: (world[5].z + world[9].z + world[13].z + world[17].z) / 4,
  };
  const axis = sub(knuckles, wrist);
  const axisLen = norm(axis);
  if (axisLen < 1e-6) return previous;
  const u = { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen };
  if (Math.abs(u.z) > 0.75) return previous;            // pointing at the lens

  const normal = cross(sub(world[5], wrist), sub(world[17], wrist));
  const reference = { x: 0, y: 0, z: 1 };
  const perp = (v) => { const k = dot(v, u); return { x: v.x - k * u.x, y: v.y - k * u.y, z: v.z - k * u.z }; };
  const n = perp(normal);
  const e = perp(reference);
  const nl = norm(n), el = norm(e);
  if (nl < 1e-9 || el < 1e-9) return previous;

  const cosine = dot(n, e) / (nl * el);
  const sine = dot(cross(e, n), u) / (nl * el);
  const measured = (Math.atan2(sine, cosine) * 180) / Math.PI;

  /* The palm normal comes from the depth of the landmarks, which is the
     weakest thing the model reports, and on a hand seen nearly edge-on it can
     flip outright — a 180 degree step that no wrist ever made. Anything
     faster than a wrist can plausibly turn in one frame is not a turn. */
  const step = normaliseDeg(measured - previous);
  if (Math.abs(step) > TWIST_MAX_STEP) return previous;
  return previous + step;
}

/**
 * @param {Array} landmarks        normalised image points — position and direction
 * @param {Array} [worldLandmarks] metric points — angles, when available
 * @param {object} [previous]      last frame's result, for hysteresis
 */
export function analyseHand(landmarks, worldLandmarks, previous) {
  const points = worldLandmarks?.length === 21 ? worldLandmarks : landmarks;
  const wrist = points[0];
  const scale = dist(points[0], points[9]) || 1;

  const up = FINGERS.map(({ joints }, index) => {
    const [mcp, pip, , tip] = joints;
    const wasUp = previous?.up?.[index] === true;
    const angle = angleAt(points[mcp], points[pip], points[tip]);
    const reach = dist(wrist, points[tip]) / (dist(wrist, points[pip]) || 1);
    return angle > (wasUp ? LIMITS.holdAngle : LIMITS.extendAngle) &&
           reach > (wasUp ? LIMITS.holdReach : LIMITS.extendReach);
  });
  const count = up.filter(Boolean).length;

  /* Thumb extension uses the same radial-reach rule as the fingers, measured
     from the wrist. A "spread from the index knuckle" test only recognises a
     thumb held out sideways and misses a thumbs-up, where the thumb rises
     alongside that knuckle rather than away from it. */
  const thumbExtended =
    angleAt(points[2], points[3], points[4]) > LIMITS.thumbAngle &&
    dist(wrist, points[4]) > dist(wrist, points[3]) * LIMITS.thumbReach;

  /* Thumb direction is screen-relative, so it is measured on image points.
     It needs a clear vertical run that also beats the horizontal one, which
     keeps a thumb held sideways from reading as either up or down. */
  const imgScale = dist2d(landmarks[0], landmarks[9]) || 1;
  const rise = landmarks[2].y - landmarks[4].y;        // +ve: tip above knuckle
  const run = Math.abs(landmarks[4].x - landmarks[2].x);
  const decisive = Math.abs(rise) > imgScale * LIMITS.thumbVertical && Math.abs(rise) > run * 0.75;
  const thumbDir = decisive ? (rise > 0 ? "up" : "down") : "none";

  /* Pinch: the thumb and index tips are together.
     
     The arch test — index tip stood off its own knuckle, forming an O — is
     needed only to separate a pinch from a thumbs-up, where the thumb tip
     also lands beside the folded index. A thumbs-up is built on a FIST, so
     the moment any other finger is extended that confusion cannot arise and
     the arch is not required.

     This matters more than it sounds. Demanding the arch of every pinch is
     what made a pinch held with three fingers out drop in and out of
     recognition — and three fingers out, with the pinch unrecognised, is the
     blue colour command. The pinch was switching the lights blue. */
  const pinchGap = dist(points[4], points[8]) / scale;
  const pinchArch = dist(points[8], points[5]) / scale;
  const wasPinching = previous?.pinching === true;
  const tipsTogether = pinchGap < (wasPinching ? LIMITS.pinchOpen : LIMITS.pinchClose);
  const arched = pinchArch > (wasPinching ? LIMITS.pinchArchHold : LIMITS.pinchArch);
  /* The count branch additionally wants the index CURLED, because that is
     what a pinch does to it. Without that, a loose fist with one finger
     half-out and the thumb tucked by the index reads as a pinch — and a pinch
     that will not let go blocks every other gesture. An index held straight
     to meet the thumb is covered by the arch branch instead. */
  const pinching = tipsTogether && (arched || (count >= 1 && !up[0]));

  const palmIds = [0, 5, 9, 13, 17];
  const palm = palmIds.reduce((acc, id) => ({
    x: acc.x + landmarks[id].x / palmIds.length,
    y: acc.y + landmarks[id].y / palmIds.length,
  }), { x: 0, y: 0 });

  /* Palm roll: the in-plane lean of the hand's long axis, measured from the
     wrist to the centre of the four knuckles. Averaging the knuckles rather
     than using one landmark is what keeps the reading steady — a single
     fingertip or knuckle jitters by a degree or two every frame, and this
     number drives brightness directly.

     Two forms come back, because they are used for different jobs:
       palmRoll  degrees in the MIRRORED frame the operator sees, 0 = fingers
                 straight up, positive = rolled to their right. This is the
                 control signal.
       palmAxis  radians in raw camera space, for drawing on a canvas that is
                 already mirrored, where landmark coordinates are used as-is. */
  const palmTwist = measureTwist(worldLandmarks, previous?.palmTwist ?? 0);

  const knuckles = [5, 9, 13, 17].reduce((acc, id) => ({
    x: acc.x + landmarks[id].x / 4,
    y: acc.y + landmarks[id].y / 4,
  }), { x: 0, y: 0 });
  const axisX = knuckles.x - landmarks[0].x;
  const axisY = knuckles.y - landmarks[0].y;
  const palmAxis = Math.atan2(axisY, axisX);
  const palmRoll = normaliseDeg((Math.atan2(axisY, -axisX) * 180) / Math.PI + 90);
  const palmSpan = Math.hypot(axisX, axisY);

  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const point of landmarks) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }

  return {
    up, count, thumbExtended, thumbDir, pinching, pinchGap, pinchArch,
    palm, palmRoll, palmAxis, palmSpan, palmTwist,
    box: { minX, minY, maxX, maxY }, landmarks,
  };
}

/**
 * Hand pose -> intent.
 *
 * Order matters, and it is the main defence against the pinch / thumbs-up
 * confusion. Thumb poses are tested first and additionally require the tips to
 * be clearly APART, while a pinch requires them clearly TOGETHER. The two
 * conditions cannot both hold, so no hand position can satisfy both rules.
 */
export function classify(hand) {
  if (!hand) return { type: "none" };

  // Thumb up / down: fist, thumb out and vertical, tips well apart.
  if (hand.count === 0 && hand.thumbExtended && hand.thumbDir !== "none" &&
      hand.pinchGap > LIMITS.thumbGapFloor) {
    return hand.thumbDir === "up"
      ? { type: "thumb_up", label: "Thumb up", detail: "Brightness rising" }
      : { type: "thumb_down", label: "Thumb down", detail: "Brightness falling" };
  }

  // Pinch: tips together and the index arched. One tap locks rotation.
  if (hand.pinching) {
    return { type: "pinch", label: "Pinch", detail: "One tap locks rotation" };
  }

  // Open palm — four fingers and the thumb all clear of the palm.
  if (hand.count === 4 && hand.thumbExtended) {
    return { type: "palm", label: "Open palm", detail: "Hold for lights on" };
  }

  // Closed fist — nothing extended at all.
  if (hand.count === 0 && !hand.thumbExtended) {
    return { type: "fist", label: "Closed fist", detail: "Lights off" };
  }

  /* Colours, but only with the thumb clear of the index.

     A hand on its way into or out of a pinch passes through three and four
     fingers, which are the blue and white commands. Requiring the thumb to be
     well away from the index tip means those transit frames cannot be read as
     a colour at all — and a real colour pose, with the thumb tucked against
     the palm, sits around 1.3, miles clear of the floor. */
  if (hand.count >= 1 && hand.count <= 4) {
    if (hand.pinchGap < LIMITS.colorGapFloor) {
      return { type: "idle", label: "Pinch forming", detail: "Thumb near the index" };
    }
    const names = ["Red", "Green", "Blue", "White"];
    return {
      type: "color", index: hand.count - 1,
      label: `${hand.count} finger${hand.count > 1 ? "s" : ""}`,
      detail: names[hand.count - 1],
    };
  }

  /* Anything else is deliberately unmapped — these are the shapes a hand
     passes through on the way somewhere else, and giving them an action is
     what causes accidental triggers. */
  return { type: "idle", label: "No command", detail: "Pose not mapped" };
}

/** Stable key for the vote window: pose identity, not raw finger count. */
export const intentKey = (intent) => (intent.type === "color" ? `color:${intent.index}` : intent.type);

/** Majority vote over recent keys; null until one clearly wins. */
export function majority(votes, windowSize, needed) {
  if (votes.length < windowSize) return null;
  const tally = new Map();
  for (const value of votes) tally.set(value, (tally.get(value) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [value, count] of tally) if (count > bestCount) { best = value; bestCount = count; }
  return bestCount >= needed ? best : null;
}

/**
 * Index-to-thumb distance -> a plain 0-100 reading.
 *
 * This is the number shown between the fingertips, so the operator can see
 * exactly how far apart the camera thinks they are and judge a pinch before
 * making one. It no longer drives brightness — rolling the palm does that —
 * because a distance that always drove the lights moved them every time a
 * hand drifted past the lens.
 */
export function gapToLevel(gap, floor = 1) {
  const t = clamp((gap - DIAL_SPAN.min) / (DIAL_SPAN.max - DIAL_SPAN.min), 0, 1);
  return clamp(Math.round(t * 100), floor, 100);
}

/**
 * Palm roll -> brightness.
 *
 * Relative to where the roll started, not to any absolute hand orientation:
 * the palm is a knob you pick up at the current level and turn. Rolling right
 * raises, left lowers, and rolling back returns to where you began, which is
 * what makes it land where you want instead of hunting.
 *
 * The slack around the anchor matters more than it looks — without it a hand
 * held as still as a hand can be held still would creep the lights by a few
 * percent a second.
 */
export function rollToLevel(anchorLevel, deltaDeg) {
  const past = Math.abs(deltaDeg) - ROLL.dead;
  if (past <= 0) return clamp(Math.round(anchorLevel), ROLL.floor, 100);
  const move = Math.sign(deltaDeg) * Math.pow(past / ROLL.span, ROLL.curve) * 100;
  return clamp(Math.round(anchorLevel + move), ROLL.floor, 100);
}

/**
 * The roll that would place the knob exactly on `level`, used to stop windup.
 *
 * Keep rolling right once the lights are already at 100 and the anchor would
 * fall ever further behind, so rolling back would do nothing for the first
 * half-turn. Re-anchoring at the saturation point means a reversal answers on
 * the very next frame.
 */
export function rollAtLevel(anchorLevel, level) {
  const move = level - anchorLevel;
  if (move === 0) return 0;
  return Math.sign(move) * (ROLL.dead + ROLL.span * Math.pow(Math.abs(move) / 100, 1 / ROLL.curve));
}

/**
 * The slack applied to the twist before it counts, in degrees.
 *
 * Larger than the roll's own slack because the twist is derived from the
 * depth of the landmarks, which is the noisiest thing the model reports. A
 * deliberate twist of the wrist is 40 degrees or more and sails past this;
 * the few degrees of jitter from a hand held still never reach it, so a
 * resting hand cannot creep the lights.
 */
export const TWIST_DEAD = 15;

/**
 * How much of a twist counts, once it is past the slack.
 *
 * Under 1 because tilting a hand and twisting it are not independent in
 * practice — turning the wrist does some of both — and counting each at full
 * weight made an ordinary turn move the lights twice as far as the hand had
 * actually turned.
 */
export const TWIST_WEIGHT = 0.6;

/** Signed amount past a slack band, zero inside it. */
export const softDead = (value, slack) =>
  Math.sign(value) * Math.max(0, Math.abs(value) - slack);

/**
 * How far the hand has turned since the knob picked it up, counting both ways
 * of turning it: the in-plane roll one for one, and the out-of-plane twist
 * once it clears its own slack.
 */
export function turnDelta(roll, twist, anchorRoll, anchorTwist) {
  return (roll - anchorRoll) +
    TWIST_WEIGHT * softDead(unwrapDeg(0, twist - anchorTwist), TWIST_DEAD);
}
