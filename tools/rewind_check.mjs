// Gate: the timeline's rewind must be EXACT. Checkpoint the engine's linear memory, run on with visitor
// actions, restore, replay the same actions, and require the same state hash. Also require that a
// DIFFERENT action after restoring gives a different hash (proves the restore did not freeze state).
import { readFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const m = (await loadCore(readFileSync(new URL('../sim/tscore.wasm', import.meta.url)))).mission;
const run = (n, acts = {}) => { for (let i = 0; i < n; i++) { if (acts[i]) acts[i](); m.step(1); const id = m.meta()[17]; if (id) m.confirm(id); } };
m.init(7, 11); run(10000);                                    // to T+1000 s (search under way)
const cp = m.checkpoint(), t0 = m.meta()[0];
const acts = { 50: () => m.zone(20000, 4000, 23000, 7000), 200: () => m.rdv(14000, 10500) };
run(5000, acts); const h1 = m.hash(), t1 = m.meta()[0];
m.restore(cp); const tr = m.meta()[0];
run(5000, acts); const h2 = m.hash();
m.restore(cp); run(5000, { 50: () => m.zone(9000, 2000, 12000, 5000) }); const h3 = m.hash();
console.log(`checkpoint at t=${t0.toFixed(0)}  run to t=${t1.toFixed(0)}  restored t=${tr.toFixed(0)}`);
console.log(`replayed same actions: ${h1 === h2 ? 'IDENTICAL' : 'DIFFERENT'}  (${h1} vs ${h2})`);
console.log(`different action after restore: ${h3 !== h1 ? 'DIFFERENT (restore is live)' : 'IDENTICAL -- restore froze state'}`);
process.exit(h1 === h2 && h3 !== h1 && tr === t0 ? 0 : 1);
