// Magic Cube (Aqara MFKZQ01LM) — HomeKit-ready Gesture Parser
// -----------------------------------------------------------------------
// Companion to magic-cube-parser.js, built for direct wiring into
// node-red-contrib-homekit-bridged (NRCHKB) with no glue logic in
// between. Every gesture gets its own output, already shaped as a
// StatelessProgrammableSwitch event; battery is shaped for NRCHKB's
// Battery linked service.
//
// NRCHKB references used to shape these payloads:
//   Stateless Programmable Switch: https://nrchkb.github.io/wiki/service/stateless-programmable-switch/
//   ProgrammableSwitchEvent:       https://nrchkb.github.io/wiki/characteristic/programmable-switch-event/
//   Battery:                       https://nrchkb.github.io/wiki/service/battery/
//
// Input:  msg.payload = the raw zigbee2mqtt state payload for the cube,
//         same as magic-cube-parser.js (live event, heartbeat, or a
//         node-red-contrib-zigbee2mqtt "get" response carrying
//         msg.payload_in).
//
// Outputs (12 total, in this order):
//    1  wakeup         -> { ProgrammableSwitchEvent: 0 }  (the cube's
//                          initial/resting gesture, so it leads — see
//                          the gesture-transition diagram in
//                          magic-cube-gesture-reference.md)
//    2  fall           -> { ProgrammableSwitchEvent: 0 }
//    3  flip180        -> { ProgrammableSwitchEvent: 0 }
//    4  flip90         -> { ProgrammableSwitchEvent: 0 }
//    5  rotate_left    -> { ProgrammableSwitchEvent: 0 }
//    6  rotate_right   -> { ProgrammableSwitchEvent: 0 }
//    7  shake          -> { ProgrammableSwitchEvent: 0 }
//    8  slide          -> { ProgrammableSwitchEvent: 0 }
//    9  tap            -> { ProgrammableSwitchEvent: 0 }  (a physical
//                          DOUBLE-tap on the real cube produces z2m's
//                          "tap" action — see magic-cube-gesture-reference.md)
//   10  throw          -> { ProgrammableSwitchEvent: 0 }
//                       (outputs 2-10: the remaining 8 actions in plain
//                       alphabetical order — no other ordering was more
//                       meaningful than the raw z2m enum order it replaces)
//   11  side           -> { side: 0-5 }, whenever the cube's resting side
//                          changes. Not itself an NRCHKB characteristic —
//                          wire it wherever "which face is up" is useful
//                          (e.g. a Function node mapping side -> scene).
//   12  battery        -> { BatteryLevel, ChargingState, StatusLowBattery },
//                          shaped for NRCHKB's Battery linked service,
//                          whenever the reported battery % changes.
//
// Wire outputs 1-10 straight to ten separate StatelessProgrammableSwitch
// nodes — independent HomeKit buttons, no Function node in between.
// Every ProgrammableSwitchEvent below defaults to 0 (single press), since
// each gesture already IS its own distinct switch; edit the literal for a
// given action (e.g. `tap`, which is physically a double-tap already) if
// you'd rather encode it as 1 (double press) on a shared switch instead.
//
// Freshness / dedup: identical fingerprint logic to magic-cube-parser.js
// (see that file's header for the full "fresh vs. stale" writeup) — a
// gesture output only fires when it's genuinely new, never on a stale
// re-report. side/battery outputs are deduped separately: they fire only
// when the value actually changes — from a live message OR from a "get"
// response, since both are legitimate readouts of current state.
// -----------------------------------------------------------------------

const OUTPUT_COUNT = 12;
const ACTION_OUTPUT_INDEX = {
    wakeup: 0,
    fall: 1,
    flip180: 2,
    flip90: 3,
    rotate_left: 4,
    rotate_right: 5,
    shake: 6,
    slide: 7,
    tap: 8,
    throw: 9
};
const SIDE_OUTPUT = 10;
const BATTERY_OUTPUT = 11;

// Battery % at/below this is reported to HomeKit as StatusLowBattery: 1.
// The cube runs on a single non-rechargeable coin cell, so ChargingState
// is always reported as 2 ("not chargeable"). Tune this threshold if you
// want an earlier/later warning in the Home app.
const LOW_BATTERY_THRESHOLD = 20;

function empty() {
    return new Array(OUTPUT_COUNT).fill(null);
}

const p = msg.payload;

if (!p || typeof p !== 'object') {
    return null;
}

const deviceId = (p.device && (p.device.ieeeAddr || p.device.friendlyName)) || msg.topic || 'unknown';
const isGetResponse = msg.payload_in !== undefined;

const store = context.get('cubeHomekitState') || {};
const prev = store[deviceId] || { action: null, fingerprint: null, side: null, battery: null };

const out = empty();

// --- side (output 11) ---------------------------------------------------
if (p.side !== undefined && p.side !== prev.side) {
    out[SIDE_OUTPUT] = Object.assign({}, msg, { payload: { side: p.side } });
}

// --- battery (output 12) -------------------------------------------------
if (p.battery !== undefined && p.battery !== prev.battery) {
    out[BATTERY_OUTPUT] = Object.assign({}, msg, {
        payload: {
            BatteryLevel: p.battery,
            ChargingState: 2, // not chargeable (single-use coin cell)
            StatusLowBattery: (p.battery <= LOW_BATTERY_THRESHOLD) ? 1 : 0
        }
    });
}

// A "get" response is a cached-state readout, never a live gesture: feed
// side/battery above, but never fire an action output, and never disturb
// the action-freshness tracking used for real live events.
if (isGetResponse) {
    store[deviceId] = Object.assign({}, prev, { side: p.side, battery: p.battery });
    context.set('cubeHomekitState', store);
    return out;
}

// No usable `action` => periodic heartbeat (or an action z2m doesn't
// define here), nothing to fire on the action outputs.
if (typeof p.action !== 'string' || p.action === '' || ACTION_OUTPUT_INDEX[p.action] === undefined) {
    store[deviceId] = Object.assign({}, prev, { side: p.side, battery: p.battery });
    context.set('cubeHomekitState', store);
    return out;
}

// Same fingerprinting as magic-cube-parser.js: identifies the fields that
// actually carry this action's meaning, so a stale re-report (identical
// fingerprint) doesn't retrigger the HomeKit switch.
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

store[deviceId] = { action: p.action, fingerprint: fp, side: p.side, battery: p.battery };
context.set('cubeHomekitState', store);

if (isFresh) {
    out[ACTION_OUTPUT_INDEX[p.action]] = Object.assign({}, msg, { payload: { ProgrammableSwitchEvent: 0 } });
}

return out;
