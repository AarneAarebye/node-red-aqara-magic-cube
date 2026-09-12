// Magic Cube (Aqara MFKZQ01LM) — Gesture Parser
// -----------------------------------------------------------------------
// Input:  msg.payload = the raw zigbee2mqtt state payload for the cube
//         (as produced by node-red-contrib-zigbee2mqtt's "zigbee2mqtt-in"
//         node, or any node that forwards the z2m JSON payload unchanged
//         — including the "get" node's response, see output 3 below)
//
// Output 1: a normalized gesture event, only when a NEW physical gesture
//           has actually happened.
// Output 2: passthrough of periodic/heartbeat reports (no `action` field
//           at all) — battery, voltage, linkquality, device_temperature.
// Output 3: snapshot response from a manually-triggered "get" request
//           (node-red-contrib-zigbee2mqtt's get node, fired by sending it
//           any input). Detected via `msg.payload_in`, which the get node
//           adds to carry the original trigger payload through. This is
//           NOT a live event — `changed.old` and `changed.new` are
//           byte-identical in a get response (even `elapsed` matches),
//           because nothing changed; it's just the cube's last known
//           cached state being read back on demand. Passed straight
//           through, normalized, without touching gesture-freshness
//           tracking or ever counting as a fresh gesture on output 1.
//
// Freshness check (v2 — see the doc's "fresh vs. stale" section for why
// this changed from an earlier `elapsed`-based version):
//   `elapsed` (ms the device thinks have passed since the action) is NOT
//   a reliable freshness signal — two genuinely distinct, real gestures
//   in a row can show an INCREASING elapsed (e.g. two flip90s a few
//   seconds apart both show growing elapsed). Instead we fingerprint the
//   fields that actually carry the gesture's meaning (side / angle /
//   from_side / to_side / action_angle, depending on the action) and
//   only treat a message as a new gesture when that fingerprint — or the
//   action itself — differs from the last one seen for this device. See
//   SUPPRESS_STALE_ACTIONS below (default true) to disable this entirely.
//   A message with the exact same action AND fingerprint as the last
//   FIRED one, within MIN_REFIRE_INTERVAL_MS, is treated as a stale
//   re-report -- most plausibly an ordinary Zigbee delivery retry, not
//   the bridge itself (see the corrected root-cause note in
//   magic-cube-gesture-reference.md).
//   Trade-off (does not apply if SUPPRESS_STALE_ACTIONS is disabled): two
//   genuinely separate occurrences of the same gesture landing within
//   MIN_REFIRE_INTERVAL_MS of each other are still coalesced into one
//   event, since nothing in the payload distinguishes them that fast.
//   Real example: a physical slide-away-and-back (two genuine slides
//   landing on the same side) produces byte-identical side/angle in
//   `old` and `new` -- see "slide from slide.json". Affects any gesture
//   without its own from/to fields (tap, shake, slide, fall, throw;
//   flip180 too if it happens to land back on the same side) whenever
//   two real occurrences share the same side/angle and land inside the
//   window. If you need to tell those apart even then, use your own
//   timing window on message arrival time (Date.now() when Node-RED
//   receives the message), not on `elapsed`.
// -----------------------------------------------------------------------

// Minimum real time (Node-RED arrival time — Date.now() when this
// function runs, NOT the payload's own `elapsed` field) that must pass
// since the last FIRED gesture before an identical action+fingerprint
// repeat is treated as a new occurrence rather than a stale duplicate.
// Only takes effect when SUPPRESS_STALE_ACTIONS (below) is true.
// zigbee2mqtt's own state cache never carries `action` into unrelated
// heartbeats (verified against zigbee2mqtt's source — action is in its
// CACHE_IGNORE_PROPERTIES list), so an identical-fingerprint repeat
// inside this window is most plausibly an ordinary Zigbee delivery
// retry, not a second real gesture. Tune this if you find genuine rapid
// repeats being coalesced, or duplicates slipping through.
const MIN_REFIRE_INTERVAL_MS = 1000;

// Master switch for stale-action suppression. Defaults to true: messages
// that repeat the last fired action AND fingerprint within
// MIN_REFIRE_INTERVAL_MS of each other are dropped -- most plausibly an
// ordinary Zigbee delivery retry, not a second real gesture. Set this to
// false to disable all suppression and let every action-bearing message
// fire immediately, with no fingerprint or debounce filtering at all
// (e.g. for debugging/inspecting the cube's raw reporting behavior).
const SUPPRESS_STALE_ACTIONS = true;

const p = msg.payload;

if (!p || typeof p !== 'object') {
    return null;
}

const deviceId = (p.device && (p.device.ieeeAddr || p.device.friendlyName)) || msg.topic || 'unknown';

// Response to a manual "get" request: not a live event, just the cube's
// current cached state being read back on demand. Never treat this as a
// fresh gesture and never let it disturb the freshness-tracking context
// used for live messages.
if (msg.payload_in !== undefined) {
    const snapshot = {
        device: deviceId,
        action: (typeof p.action === 'string' && p.action !== '') ? p.action : null,
        side: p.side,
        angle: p.angle,
        battery: p.battery,
        voltage: p.voltage,
        device_temperature: p.device_temperature,
        linkquality: p.linkquality,
        power_outage_count: p.power_outage_count,
        timestamp: Date.now()
    };
    const msg3 = Object.assign({}, msg, { payload: snapshot });
    return [null, null, msg3];
}

const store = context.get('cubeState') || {};
const prev = store[deviceId] || { action: null, fingerprint: null };

// No `action` key at all => periodic status/heartbeat report, no gesture.
if (typeof p.action !== 'string' || p.action === '') {
    const heartbeat = {
        device: deviceId,
        battery: p.battery,
        voltage: p.voltage,
        device_temperature: p.device_temperature,
        linkquality: p.linkquality,
        power_outage_count: p.power_outage_count,
        side: p.side,
        angle: p.angle,
        timestamp: Date.now()
    };
    const msg2 = Object.assign({}, msg, { payload: heartbeat });
    return [null, msg2, null];
}

// Build a fingerprint of the fields that actually carry this action's
// meaning, so a stale re-report (identical fingerprint) can be told apart
// from a genuinely new occurrence of the same action.
function fingerprint(action, payload) {
    switch (action) {
        case 'flip90': {
            const from = (payload.from_side !== undefined) ? payload.from_side : payload.action_from_side;
            const to = (payload.to_side !== undefined) ? payload.to_side : payload.action_to_side;
            return payload.side + '|' + from + '|' + to;
        }
        case 'flip180':
            return String(payload.side);
        case 'rotate_left':
        case 'rotate_right': {
            const rot = (payload.action_angle !== undefined) ? payload.action_angle : payload.angle;
            return String(rot);
        }
        default: // wakeup, tap, shake, slide, fall, throw
            return payload.side + '|' + payload.angle;
    }
}

const now = Date.now();
const fp = fingerprint(p.action, p);
const refired = (prev.lastFiredAt === undefined) || (now - prev.lastFiredAt >= MIN_REFIRE_INTERVAL_MS);
const isFresh = !SUPPRESS_STALE_ACTIONS || (p.action !== prev.action) || (fp !== prev.fingerprint) || refired;

store[deviceId] = {
    action: p.action,
    fingerprint: fp,
    lastFiredAt: isFresh ? now : prev.lastFiredAt
};
context.set('cubeState', store);

if (!isFresh) {
    return null; // stale re-report of the same gesture, ignore
}

const gesture = {
    device: deviceId,
    action: p.action,
    side: p.side,
    angle: p.angle,
    elapsed_ms: p.elapsed,
    battery: p.battery,
    voltage: p.voltage,
    linkquality: p.linkquality,
    timestamp: Date.now()
};

switch (p.action) {
    case 'flip90':
        gesture.from_side = (p.from_side !== undefined) ? p.from_side : p.action_from_side;
        gesture.to_side = (p.to_side !== undefined) ? p.to_side : p.action_to_side;
        break;
    case 'rotate_left':
    case 'rotate_right':
        gesture.rotation_angle = (p.action_angle !== undefined) ? p.action_angle : p.angle;
        break;
}

msg.payload = gesture;
return [msg, null, null];
