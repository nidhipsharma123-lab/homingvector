// Gate: same seed -> identical state hash after N ticks; different seed -> different; and a
// scripted attack must produce the product's reactions (not just "no crash").
import { readFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const bytes = readFileSync(new URL('../sim/tscore.wasm', import.meta.url));
const N = +(process.argv[2] || 1200);
async function run(seed, attack, verbose) {
  const c = await loadCore(bytes); c.init(seed); let log = '';
  for (let i = 0; i < N; i++) {
    if (attack && i === 120) c.jam(900, 200, 2000, 1000);
    if (attack && i === 200) c.destroy(1);
    if (attack && i === 260) c.spoof(1800, 1500, 3200, 2000);
    if (attack && i === 300) c.bandwidth(0.35);
    c.step(1); log += c.drainLog();
  }
  if (verbose) return { h: c.hash(), m: c.metrics(), log };
  return c.hash();
}
let code = 0;
const a1 = await run(7, true), a2 = await run(7, true), b = await run(8, true);
console.log(`determinism: seed7=${a1} seed7'=${a2} seed8=${b}`);
if (a1 !== a2) { console.log('FAIL same seed diverged'); code = 1; }
if (a1 === b) { console.log('FAIL different seeds identical -- the seed is not reaching the sim'); code = 1; }
const r = await run(7, true, true);
const m = r.m;
console.log(`t=${m[5]}s alive=${m[0]} completion=${m[1].toFixed(1)}% owned=${m[2].toFixed(1)}% conn=${m[3].toFixed(0)}% realloc=${m[4]}s complete_at=${m[6]}`);
const need = { 'destroyed': /destroyed/, 'dead reckoning ladder': /NOMINAL -> DEGRADED_NAV|-> DEGRADED_NAV/i, 'silent peer declared': /declared DEAD/i, 'work taken over': /took station/, 'spoof detected': /SPOOF DETECTED/ };
for (const [k, re] of Object.entries(need)) { const ok = re.test(r.log); console.log(`  ${ok ? 'ok  ' : 'MISS'} ${k}`); if (!ok) code = 1; }
if (process.argv.includes('--log')) console.log(r.log);
process.exit(code);
