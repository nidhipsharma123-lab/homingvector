// The static rung of the degradation ladder: a real frame of the swarm mission engine (scenario 6,
// search phase, after a loss), drawn as SVG -- not an illustration of one.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const m = (await loadCore(readFileSync(new URL('../sim/tscore.wasm', import.meta.url)))).mission;
m.init(6, 11);
while (m.meta()[0] < 1300 && m.meta()[1] < 9) { m.step(50); const id = m.meta()[17]; if (id) m.confirm(id); }
m.drainLog();
const { buf: S, n, nl } = m.snapshot(), G = m.geom(), me = m.meta(), UF = 24;
const x0 = 14500, x1 = 26500, y0 = 1800, y1 = 12200, W = 1600, H = 960, k = Math.min(W / (x1 - x0), H / (y1 - y0));
const X = x => ((x - x0) * k).toFixed(1), Y = y => (H - (y - y0) * k).toFixed(1);
let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="IBM Plex Mono, monospace" font-size="13"><rect width="${W}" height="${H}" fill="#090a08"/>`;
o += `<rect x="${X(G[14])}" y="${Y(G[17])}" width="${((G[16] - G[14]) * k).toFixed(1)}" height="${((G[17] - G[15]) * k).toFixed(1)}" fill="none" stroke="#f2f0ea" stroke-opacity=".4" stroke-dasharray="2 4"/>`;
o += `<text x="${+X(G[14]) + 8}" y="${+Y(G[17]) - 8}" fill="#a6a49d">SEARCH AREA · ABSTRACT, SIMULATED</text>`;
for (let l = 0; l < nl; l++) { const b = n * UF + n * n + l * 7, st = S[b + 5]; o += `<path d="M${X(S[b])} ${Y(S[b + 1])}L${X(S[b + 2])} ${Y(S[b + 3])}" stroke="#f2f0ea" stroke-opacity="${st === 3 ? .16 : st === 2 ? .75 : .35}"${st < 2 ? ' stroke-dasharray="4 5"' : ''}/>`; }
for (let i = 0; i < n; i++) {
  const b = i * UF, st = S[b + 7], x = +X(S[b]), y = +Y(S[b + 1]), id = `U${String(i + 1).padStart(2, '0')}`;
  if (st === 0 || st === 6) continue;
  if (st === 5) { o += `<path d="M${x - 7} ${y - 7}l14 14m0-14l-14 14" stroke="#ff4a2b" stroke-width="2"/><text x="${x + 10}" y="${y - 8}" fill="#ff4a2b">${id} LOST</text>`; continue; }
  const deg = (-S[b + 3] * 57.2958).toFixed(1);
  o += `<path transform="translate(${x} ${y}) rotate(${deg})" d="M10 0L2.5 1L.6 9.2L-1.2 9.2L-2.2 1L-6.2 .8L-7.4 3.8L-8.6 3.8L-8 0L-8.6 -3.8L-7.4 -3.8L-6.2 -.8L-2.2 -1L-1.2 -9.2L.6 -9.2L2.5 -1Z" fill="${S[b + 5] ? '#090a08' : '#f2f0ea'}" stroke="#f2f0ea" stroke-width="${S[b + 5] ? 1.4 : 0}"/>`;
  o += `<text x="${x + 13}" y="${y - 8}" fill="#a6a49d">${id}${S[b + 6] ? ' L' : ''}</text>`;
}
o += `<text x="16" y="${H - 16}" fill="#6f6e69">A REAL FRAME OF THE SWARM MISSION ENGINE · SCENARIO 6, SEED 11, T+${Math.floor(me[0])} S · GROUP A FILLED, GROUP B OUTLINED</text></svg>\n`;
writeFileSync(new URL('../brand/sim-static.svg', import.meta.url), o);
console.log('sim-static.svg', o.length, 'bytes at t', Math.floor(me[0]), 'phase', me[1]);
