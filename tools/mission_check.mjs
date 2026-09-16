// Gate for the swarm mission engine: every scenario must reach COMPLETE with an operator who confirms,
// the same seed must give the same state hash, and the failure scenarios must show the reactions the
// page describes. A demo that stalls in a hold is a broken demo, however good it looks for 20 s.
import { readFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const bytes = readFileSync(new URL('../sim/tscore.wasm', import.meta.url));
const PH = ['LAUNCH', 'ASSEMBLY', 'FORMATION', 'TRANSIT', 'SPLIT', 'SEARCH', 'RENDEZVOUS', 'REFORM', 'RETURN', 'COMPLETE'];
const verbose = process.argv.includes('--log');
async function run(sc, seed, maxT = 4000) {
  const c = await loadCore(bytes), m = c.mission; m.init(sc, seed);
  let log = '', phases = [], lastPh = -1, pendSince = -1;
  while (true) {
    m.step(10); log += m.drainLog();
    const me = m.meta(), t = me[0], ph = me[1];
    if (ph !== lastPh) { phases.push(`${PH[ph]}@${t.toFixed(0)}`); lastPh = ph; }
    if (me[17] > 0) { if (pendSince < 0) pendSince = t; if (t - pendSince > 8) { m.confirm(me[17]); pendSince = -1; } }
    if (ph === 9 || t > maxT) return { t, me, log, phases, hash: m.hash() };
  }
}
const need = {
  1: [/GPS unavailable/, /GPS restored|GPS available again/],
  2: [/formation WEDGE -> |formation .* -> V|formation .* -> COLUMN/, /leaves formation/, /REJOINING|back in slot/],
  3: [/SPLIT/, /RENDEZVOUS/, /MISSION COMPLETE/],
  4: [/GPS denied/, /GPS unavailable/, /-> DEGRADED_NAV/],
  5: [/radio links degraded/, /COMMS LOST/, /link restored/],
  6: [/lost/, /leader U01 -> /, /took lane/],
  7: [/GPS denied/, /COMMS LOST/, /leaves formation/, /took lane/, /MISSION COMPLETE/],
};
let code = 0;
for (let sc = 1; sc <= 7; sc++) {
  const r = await run(sc, 11), r2 = await run(sc, 11);
  const me = r.me, done = me[1] === 9;
  const miss = need[sc].filter(re => !re.test(r.log));
  const det = r.hash === r2.hash;
  console.log(`scenario ${sc}: ${done ? 'COMPLETE' : 'STALLED'} at t=${r.t.toFixed(0)}s  lost=${me[11]} landed=${me[12]}  deterministic=${det}  missing=${miss.length}`);
  console.log(`   ${r.phases.join(' > ')}`);
  miss.forEach(x => console.log(`   MISSING ${x}`));
  if (!done || !det || miss.length) code = 1;
  if (verbose && sc === +process.argv[process.argv.indexOf('--log') + 1]) console.log(r.log);
}
process.exit(code);
