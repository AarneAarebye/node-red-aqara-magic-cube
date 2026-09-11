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
//   action itself — differs from the last one seen for this device. A
//   message with the exact same action AND fingerprint as last time is
//   treated as a stale re-report (this is how the bridge repeats
//   "wakeup" verbatim during periodic refreshes).
//   Trade-off (CONFIRMED, not just theoretical): two truly identical,
//   rapid repeats of the same gesture will be coalesced into one event,
//   since nothing in the payload distinguishes them. Real example: a
//   physical slide-away-and-back (two genuine slides landing on the same
//   side) produces byte-identical side/angle in `old` and `new` --
//   see "slide from slide.json". Affects any gesture without its own
//   from/to fields (tap, shake, slide, fall, throw; flip180 too if it
//   happens to land back on the same side) whenever two real occurrences
//   share the same side/angle. If you need to tell those apart, do it
//   with your own timing window on message arrival time (Date.now() when
//   Node-RED receives the message), not on `elapsed`.
// -----------------------------------------------------------------------

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

const fp = fingerprint(p.action, p);
const isFresh = (p.action !== prev.action) || (fp !== prev.fingerprint);

store[deviceId] = { action: p.action, fingerprint: fp };
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
