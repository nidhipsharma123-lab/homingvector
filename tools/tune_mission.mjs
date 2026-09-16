// Automated tuning of the DEMONSTRATION steering gains (never product code, never physics limits).
// (mu, lambda) evolution strategy with self-adapting step size, over deterministic scenarios, so a
// score is reproducible and an improvement is real rather than luck.
//   node tools/tune_mission.mjs [generations] [--baseline]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const bytes = readFileSync(new URL('../sim/tscore.wasm', import.meta.url));
const NAMES = ['along-track gain', 'aim lead (m)', 'leader lag slowdown', 'ring cut-across (m)', 'ring gain', 'ring rate'];
const LO = [0.005, 120, 0.002, 150, 0.005, 0.3], HI = [0.12, 900, 0.04, 900, 0.1, 0.9];
const BASE = [0.03, 350, 0.01, 350, 0.03, 0.55];
const SCEN = [3, 5], SEED = 11;
const core = await loadCore(bytes); const m = core.mission;
function evaluate(p) {
  let J = 0; const parts = [];
  for (const sc of SCEN) {
    p.forEach((v, i) => m.tune(i, v)); m.init(sc, SEED);
    let me;
    while (true) { m.step(50); m.drainLog(); me = m.meta(); if (me[17]) m.confirm(me[17]); if (me[1] === 9 || me[0] > 4500) break; }
    const done = me[1] === 9, err = me[26], dur = me[0], yields = me[27];
    J += err + 0.05 * dur + 15 * yields + (done ? 0 : 5000);
    parts.push({ sc, done, err: +err.toFixed(1), dur: Math.round(dur), yields });
  }
  return { J, parts };
}
const clamp = p => p.map((v, i) => Math.min(HI[i], Math.max(LO[i], v)));
if (process.argv.includes('--baseline')) { console.log(JSON.stringify(evaluate(BASE))); process.exit(0); }
const G = +(process.argv[2] || 12), LAMBDA = 8, MU = 3;
let parent = BASE.slice(), best = { p: BASE.slice(), ...evaluate(BASE) }, sigma = 0.25;
console.log(`baseline J=${best.J.toFixed(1)} ${JSON.stringify(best.parts)}`);
let rng = 12345; const rnd = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
for (let g = 0; g < G; g++) {
  const kids = [];
  for (let k = 0; k < LAMBDA; k++) {
    const s = sigma * Math.exp(0.3 * gauss());
    const p = clamp(parent.map((v, i) => v * Math.exp(s * gauss())));          // log-space mutation
    kids.push({ p, s, ...evaluate(p) });
  }
  kids.sort((a, b) => a.J - b.J);
  const elite = kids.slice(0, MU);
  parent = clamp(parent.map((_, i) => Math.exp(elite.reduce((acc, e) => acc + Math.log(e.p[i]), 0) / MU)));
  sigma = elite.reduce((a, e) => a + e.s, 0) / MU;
  if (elite[0].J < best.J) best = elite[0];
  console.log(`gen ${g + 1}: best J=${best.J.toFixed(1)} gen-best=${elite[0].J.toFixed(1)} sigma=${sigma.toFixed(3)} ${JSON.stringify(elite[0].parts)}`);
}
console.log('BEST', JSON.stringify({ J: best.J, parts: best.parts, params: Object.fromEntries(best.p.map((v, i) => [NAMES[i], +v.toPrecision(4)])) }));
writeFileSync(new URL('../sim/tuned.json', import.meta.url), JSON.stringify({ method: '(3,8) evolution strategy, log-space mutation, self-adapted step size', scenarios: SCEN, seed: SEED,
  objective: 'mean slot error (m) + 0.05 x mission seconds + 15 x separation yields + 5000 if not complete', baseline: evaluate(BASE), best: { J: best.J, parts: best.parts, params: best.p } }, null, 1));
