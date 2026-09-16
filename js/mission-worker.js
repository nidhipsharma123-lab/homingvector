// Runs the swarm mission off the main thread and owns its TIMELINE: every visitor action is recorded
// with the step it happened on, and the engine's linear memory is checkpointed every 120 simulated
// seconds, so seeking backwards restores a checkpoint and replays forward -- an exact rewind, not a guess.
import { loadCore } from './sim-core.js';

const DT = 0.1, TICK_MS = 33, MAX_STEPS = 500, CP_EVERY = 1200;
let m = null, playing = true, visible = false, simPerSec = 30, acc = 0, last = 0, timer = null, geomSent = false;
let k = 0, scenario = 7, seed = 11, actions = [], cps = new Map();

function apply(a) {
  switch (a.fn) {
    case 'event': m.event(a.kind, a.arg); break;
    case 'confirm': m.confirm(a.id); break;
    case 'zone': m.zone(a.x0, a.y0, a.x1, a.y1); break;
    case 'zonesClear': m.zonesClear(); break;
    case 'rdv': m.rdv(a.x, a.y); break;
  }
}
function stepTo(target) {                     // advance to step `target`, replaying recorded actions on their steps
  while (k < target) {
    for (const a of actions) if (a.k === k) apply(a);
    if (k % CP_EVERY === 0 && !cps.has(k)) cps.set(k, m.checkpoint());
    m.step(1); k++;
  }
}
function publish(withGeom) {
  const s = m.snapshot();
  const msg = { type: 'frame', snap: s.buf, n: s.n, nl: s.nl, meta: m.meta(), decision: m.decision(), log: m.drainLog(), hash: m.hash(), zones: m.zones(), step: k };
  if (withGeom || !geomSent) { msg.geom = m.geom(); geomSent = true; }
  postMessage(msg, [msg.snap.buffer, msg.meta.buffer]);
}
function tick() {
  const now = performance.now(), dt = Math.min(.25, (now - last) / 1000); last = now;
  if (!m || !playing || !visible) return;
  if (m.meta()[1] === 9) return;                                   // complete: nothing left to simulate
  acc += dt * simPerSec;
  const n = Math.min(MAX_STEPS, Math.floor(acc / DT));
  if (n <= 0) return;
  stepTo(k + n); acc -= n * DT; if (acc > 2) acc = 0;
  publish(false);
}
function record(a) {                          // a new action branches the timeline: forget the recorded future
  a.k = k; actions = actions.filter(x => x.k <= k); actions.push(a);
  for (const key of [...cps.keys()]) if (key > k) cps.delete(key);
  apply(a); publish(false);
}

onmessage = async ({ data: q }) => {
  try {
    switch (q.type) {
      case 'init': {
        if (!m) { const bytes = await (await fetch(new URL('../sim/tscore.wasm', import.meta.url))).arrayBuffer(); m = (await loadCore(bytes)).mission; }
        scenario = q.scenario; seed = q.seed; actions = []; cps = new Map(); k = 0;
        m.init(scenario, seed); m.drainLog(); acc = 0; geomSent = false;
        if (q.at > 0) {                        // ?at= : fast-forward; decisions on the way are confirmed by the demo operator
          while (k < q.at / DT && m.meta()[1] < 9) { stepTo(k + 50); const id = m.meta()[17]; if (id) { const a = { fn: 'confirm', id, k }; actions.push(a); apply(a); } }
          m.drainLog();
        }
        publish(true);
        if (!timer) { last = performance.now(); timer = setInterval(tick, TICK_MS); }
        postMessage({ type: 'ready', scenario, seed });
        break;
      }
      case 'seek': {                           // exact: restore the nearest earlier checkpoint, replay forward
        const target = Math.max(0, Math.round(q.t / DT));
        let best = -1; for (const key of cps.keys()) if (key <= target && key > best) best = key;
        if (best < 0 || target < k || best > k) {
          if (best >= 0) { m.restore(cps.get(best)); k = best; } else { m.init(scenario, seed); k = 0; }
        }
        stepTo(target); m.drainLog(); acc = 0;
        publish(true); postMessage({ type: 'seeked', t: k * DT });
        break;
      }
      case 'play': playing = !!q.on; last = performance.now(); break;
      case 'visible': visible = !!q.on; last = performance.now(); break;
      case 'speed': simPerSec = q.v; break;
      case 'step': stepTo(k + Math.round(q.sec / DT)); publish(false); break;
      case 'event': record({ fn: 'event', kind: q.kind, arg: q.arg }); break;
      case 'confirm': record({ fn: 'confirm', id: q.id }); break;
      case 'zone': record({ fn: 'zone', x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1 }); break;
      case 'zonesClear': record({ fn: 'zonesClear' }); break;
      case 'rdv': record({ fn: 'rdv', x: q.x, y: q.y }); break;
    }
  } catch (e) { postMessage({ type: 'error', message: String((e && e.message) || e) }); }
};
