// Runs the swarm mission (TurtleShield core + demonstration mission script) off the main thread.
// Paces simulated time against real time at the chosen speed; the page only draws what this posts.
import { loadCore } from './sim-core.js';

const DT = 0.1, TICK_MS = 33, MAX_STEPS = 400;
let m = null, playing = true, visible = false, simPerSec = 30, acc = 0, last = 0, timer = null, geomSent = false;

function publish(withGeom) {
  const s = m.snapshot();
  const msg = { type: 'frame', snap: s.buf, n: s.n, nl: s.nl, meta: m.meta(), decision: m.decision(), log: m.drainLog(), hash: m.hash() };
  if (withGeom || !geomSent) { msg.geom = m.geom(); geomSent = true; }
  postMessage(msg, [msg.snap.buffer, msg.meta.buffer]);
}

function tick() {
  const now = performance.now(), dt = Math.min(.25, (now - last) / 1000); last = now;
  if (!m || !playing || !visible) return;
  acc += dt * simPerSec;
  const k = Math.min(MAX_STEPS, Math.floor(acc / DT));
  if (k <= 0) return;
  m.step(k); acc -= k * DT; if (acc > 1) acc = 0;
  publish(false);
}

onmessage = async ({ data: q }) => {
  try {
    switch (q.type) {
      case 'init': {
        if (!m) { const bytes = await (await fetch(new URL('../sim/tscore.wasm', import.meta.url))).arrayBuffer(); m = (await loadCore(bytes)).mission; }
        m.init(q.scenario, q.seed); acc = 0; geomSent = false;
        // ?at=SECONDS fast-forwards (for sharing a moment and for screenshots). Decisions met on the way
        // are confirmed by the demo operator, and the log says so.
        if (q.at > 0) { for (let i = 0; i < q.at / DT && m.meta()[1] < 9; i += 50) { m.step(50); const id = m.meta()[17]; if (id) m.confirm(id); } }
        publish(true);
        if (!timer) { last = performance.now(); timer = setInterval(tick, TICK_MS); }
        postMessage({ type: 'ready', scenario: q.scenario, seed: q.seed });
        break;
      }
      case 'play': playing = !!q.on; last = performance.now(); break;
      case 'visible': visible = !!q.on; last = performance.now(); break;
      case 'speed': simPerSec = q.v; break;
      case 'step': m.step(Math.round(q.sec / DT)); publish(false); break;
      case 'event': m.event(q.kind, q.arg); publish(false); break;
      case 'confirm': m.confirm(q.id); publish(false); break;
    }
  } catch (e) { postMessage({ type: 'error', message: String((e && e.message) || e) }); }
};
