// Runs the TurtleShield core off the main thread. The page only draws what this posts.
import { loadCore } from './sim-core.js';

const STEPS_PER_TICK = 2;     // 0.5 s per step, 20 ticks/s -> 20x real time
const TICK_MS = 50;
let core = null, seed = 1, timer = null, paused = false, visible = true;

async function boot(s) {
  if (!core) {
    const bytes = await (await fetch(new URL('../sim/tscore.wasm', import.meta.url))).arrayBuffer();
    core = await loadCore(bytes);
  }
  seed = s; core.init(seed);
  postMessage({ type: 'ready', seed, nv: core.nv, nt: core.ntasks() });
  publish();
}

function publish() {
  postMessage({ type: 'frame', t: core.time(), snap: core.snapshot(), metrics: core.metrics(), log: core.drainLog(), hash: core.hash() });
}

function loop() {
  clearInterval(timer);
  timer = setInterval(() => { if (!core || paused || !visible) return; core.step(STEPS_PER_TICK); publish(); }, TICK_MS);
}

onmessage = async ({ data: m }) => {
  try {
    switch (m.type) {
      case 'init': await boot(m.seed); loop(); break;
      case 'reset': core.init(m.seed ?? seed); seed = m.seed ?? seed; postMessage({ type: 'ready', seed, nv: core.nv, nt: core.ntasks() }); publish(); break;
      case 'pause': paused = !!m.on; break;
      case 'visible': visible = !!m.on; break;
      case 'jam': core.jam(m.x0, m.y0, m.x1, m.y1); break;
      case 'spoof': core.spoof(m.x0, m.y0, m.x1, m.y1); break;
      case 'sever': core.sever(m.a, m.b); break;
      case 'destroy': core.destroy(m.i); break;
      case 'band': core.bandwidth(m.f); break;
    }
  } catch (e) { postMessage({ type: 'error', message: String(e && e.message || e) }); }
};
