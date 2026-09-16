// The static rung of the degradation ladder: a real snapshot of the real core, not a drawing of one.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadCore } from '../js/sim-core.js';
const c = await loadCore(readFileSync(new URL('../sim/tscore.wasm', import.meta.url)));
const NV = 12, VF = 14, WW = 3200, WH = 2000, SH = 1450, K = 0.4;
c.init(7);
for (let i = 0; i < 440; i++) { if (i === 60) c.jam(1700, 150, 3100, 1100); if (i === 140) c.destroy(1); if (i === 240) c.spoof(1500, 1500, 3200, 2000); c.step(1); }
c.drainLog();
const s = c.snapshot(), nt = c.ntasks(), X = x => (x * K).toFixed(1), Y = y => ((WH - y) * K).toFixed(1);
const names = []; { const n = [0,0,0], KN = ['AIR','GND','SEA']; for (let i = 0; i < NV; i++) { const k = i < 6 ? 0 : i < 9 ? 1 : 2; names.push(`${KN[k]}-${String(++n[k]).padStart(2,'0')}`); } }
let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800" font-family="IBM Plex Mono, monospace" font-size="12">`;
o += `<rect width="1280" height="800" fill="#0d0e0b"/><rect width="1280" height="${Y(SH)}" fill="#0a1013"/><path d="M0 ${Y(SH)}H1280" stroke="#2a3a40" stroke-width="2"/>`;
o += `<rect x="${X(1700)}" y="${Y(1100)}" width="${1400*K}" height="${950*K}" fill="#ff4a2b" fill-opacity=".08" stroke="#ff4a2b"/><text x="${+X(1700)+6}" y="${+Y(1100)+16}" fill="#ff4a2b">GNSS JAMMED</text>`;
o += `<rect x="${X(1500)}" y="${Y(2000)}" width="${1700*K}" height="${500*K}" fill="none" stroke="#ff4a2b" stroke-dasharray="6 5"/><text x="${+X(1500)+6}" y="${+Y(2000)+16}" fill="#ff4a2b">GNSS SPOOFED</text>`;
for (let t = 0; t < nt; t++) { const b = NV*VF + t*4, st = s[b+2]; o += st === 2 ? `<rect x="${+X(s[b])-5}" y="${+Y(s[b+1])-5}" width="10" height="10" fill="#3a3a36"/>` : `<rect x="${+X(s[b])-6}" y="${+Y(s[b+1])-6}" width="12" height="12" fill="none" stroke="${st===1?'#a6a49d':'#55544f'}"/>`; }
for (let i = 0; i < NV; i++) {
  const b = i*VF, x = +X(s[b]), y = +Y(s[b+1]);
  if (!s[b+6]) { o += `<path d="M${x-7} ${y-7}l14 14m0-14l-14 14" stroke="#ff4a2b" stroke-width="2"/><text x="${x+10}" y="${y-8}" fill="#ff4a2b">${names[i]} DESTROYED</text>`; continue; }
  if (s[b+10] >= 0) o += `<path d="M${x} ${y}L${X(s[b+10])} ${Y(s[b+11])}" stroke="#f2f0ea" stroke-opacity=".25" stroke-dasharray="3 5"/>`;
  if (s[b+4] > 8) o += `<circle cx="${X(s[b+2])}" cy="${Y(s[b+3])}" r="${Math.max(4, s[b+4]*K).toFixed(1)}" fill="none" stroke="#a6a49d" stroke-opacity=".5"/>`;
  o += `<rect x="${x-5}" y="${y-5}" width="10" height="10" fill="#f2f0ea" transform="rotate(45 ${x} ${y})"/><text x="${x+12}" y="${y-9}" fill="#a6a49d">${names[i]}</text>`;
}
o += `<text x="12" y="788" fill="#6f6e69">SNAPSHOT OF THE TURTLESHIELD CORE, SEED 7, T+${Math.floor(c.time())} S</text></svg>\n`;
writeFileSync(new URL('../brand/sim-static.svg', import.meta.url), o);
console.log('sim-static.svg', o.length, 'bytes at t', c.time());
