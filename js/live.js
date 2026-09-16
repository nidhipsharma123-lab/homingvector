// The live contested environment: renders worker snapshots, owns the adversary toolbar, the
// guided demo, the decision log and its narration. It never decides anything about the swarm.
const $ = (s, r = document) => r.querySelector(s);
const WORLD_W = 3200, WORLD_H = 2000, SHORE = 1450, NV = 12, VF = 14;
const RUNG = ['NOMINAL', 'DEGRADED_NAV', 'DEGRADED_COMMS', 'ISOLATED', 'LOST'];
const KIND = ['AIR', 'GND', 'SEA'];

export function startLive({ watch, cue, RM }) {
  const cv = $('#map'), ctx = cv.getContext('2d');
  const hint = $('#tool-hint'), dlog = $('#dlog'), narrate = $('#narrate');
  const W = cv.width, H = cv.height, K = W / WORLD_W;
  const wx = x => x * K, wy = y => (WORLD_H - y) * K;                        // world (north up) -> canvas
  const ix = px => px / K, iy = py => WORLD_H - py / K;

  const names = []; { const n = [0, 0, 0]; for (let i = 0; i < NV; i++) { const k = i < 6 ? 0 : i < 9 ? 1 : 2; names.push(`${KIND[k]}-${String(++n[k]).padStart(2, '0')}`); } }

  // ---------------- seed: from ?seed=, else a fresh one; always shown and shareable
  const q = new URLSearchParams(location.search);
  let seed = Math.max(1, Math.min(999999, parseInt(q.get('seed'), 10) || (1 + Math.floor(Math.random() * 99999))));
  const setSeed = s => { seed = s; $('#seed').textContent = s; $('#share').href = `?seed=${s}#live`; };
  setSeed(seed);

  // ---------------- static terrain layer, drawn once (deterministic, not decorative noise)
  const terrain = document.createElement('canvas'); terrain.width = W; terrain.height = H;
  (() => {
    const t = terrain.getContext('2d');
    t.fillStyle = '#0d0e0b'; t.fillRect(0, 0, W, H);
    t.fillStyle = '#0a1013'; t.fillRect(0, 0, W, wy(SHORE));
    t.strokeStyle = '#1b1d18'; t.lineWidth = 1;
    const hills = [[1300, 700, 1], [2500, 450, 1.3], [700, 1100, .7], [2100, 1150, .8]];
    for (const [hx, hy, s] of hills) for (let k = 1; k < 8; k++) {
      t.beginPath();
      for (let a = 0; a <= 64; a++) {
        const th = a / 64 * Math.PI * 2, r = k * 55 * s * (1 + .16 * Math.sin(3 * th + hx) + .07 * Math.cos(5 * th + hy));
        const px = wx(hx + Math.cos(th) * r), py = wy(Math.min(SHORE - 10, hy + Math.sin(th) * r));
        a ? t.lineTo(px, py) : t.moveTo(px, py);
      }
      t.stroke();
    }
    t.strokeStyle = '#2a3a40'; t.lineWidth = 2; t.beginPath(); t.moveTo(0, wy(SHORE)); t.lineTo(W, wy(SHORE)); t.stroke();
    t.strokeStyle = '#161714'; t.lineWidth = 1; t.font = '11px "IBM Plex Mono", monospace'; t.fillStyle = '#4a4a45';
    for (let x = 0; x <= WORLD_W; x += 500) { t.beginPath(); t.moveTo(wx(x), 0); t.lineTo(wx(x), H); t.stroke(); if (x) t.fillText(`${x / 1000} KM`, wx(x) + 4, H - 8); }
    for (let y = 0; y <= WORLD_H; y += 500) { t.beginPath(); t.moveTo(0, wy(y)); t.lineTo(W, wy(y)); t.stroke(); }
    t.fillText('LAND · AIR + GROUND STATIONS', 12, H - 26); t.fillText('WATER · AIR + SURFACE STATIONS', 12, 20);
    t.fillStyle = '#6f6e69'; t.fillRect(wx(150) - 5, wy(150) - 5, 10, 10); t.fillText('GCS', wx(150) + 9, wy(150) + 4);
  })();

  // ---------------- worker
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  let prev = null, cur = null, curAt = 0, nt = 30, frames = 0;
  const jams = [], spoofs = [];            // drawn from our own commands; the core owns the effect
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'ready') { nt = m.nt; prev = cur = null; hint.textContent = demo.active ? hint.textContent : 'Choose an adversary control, then act on the map.'; }
    else if (m.type === 'frame') { prev = cur; cur = m; curAt = performance.now(); if (m.log) ingest(m.log); metrics(m.metrics); $('#sim-clock').textContent = clock(m.t); frames++; }
    else if (m.type === 'error') { hint.textContent = `Simulation error: ${m.message}`; }
  };
  worker.postMessage({ type: 'init', seed });
  watch(cv, v => worker.postMessage({ type: 'visible', on: v }), false);

  const clock = t => { const s = Math.floor(t); return `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  // ---------------- metrics
  const M = { alive: $('#m-alive'), done: $('#m-done'), owned: $('#m-owned'), conn: $('#m-conn'), realloc: $('#m-realloc') };
  function metrics(m) {
    M.alive.textContent = `${m[0]}/${NV}`; M.alive.classList.toggle('bad', m[0] < NV);
    M.done.textContent = `${m[1].toFixed(0)}%`;
    M.owned.textContent = `${m[2].toFixed(0)}%`;
    M.conn.textContent = `${m[3].toFixed(0)}%`; M.conn.classList.toggle('bad', m[3] < 100);
    M.realloc.textContent = m[4] >= 0 ? `${m[4].toFixed(1)} s` : '–';
  }

  // ---------------- decision log + narration + event-driven glitch/sound
  let lastSay = 0, sayQueue = '';
  function ingest(text) {
    const lines = text.split('\n').filter(Boolean);
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      if (/surveyed$/.test(line) && !/NOT/.test(line)) continue;         // routine; the metric carries it
      const li = document.createElement('li'), b = document.createElement('b');
      b.textContent = line.slice(0, 7); li.append(b, line.slice(8));
      if (/ADVERSARY/.test(line)) li.className = 'adv';
      else if (/took station|MISSION COMPLETE|SPOOF DETECTED|GNSS restored/.test(line)) li.className = 'good';
      frag.prepend(li);
      if (/destroyed|declared DEAD/.test(line)) { glitch(); cue('impact'); sayQueue = line.slice(8); }
      else if (/SPOOF DETECTED|jamming|spoofing|severed|bandwidth/.test(line)) { glitch(); cue('tick'); sayQueue = line.slice(8); }
      else if (/took station|MISSION COMPLETE/.test(line)) { cue('good'); sayQueue = line.slice(8); }
    }
    dlog.prepend(frag);
    while (dlog.children.length > 160) dlog.lastChild.remove();
    const now = performance.now();
    if (sayQueue && now - lastSay > 3000) { narrate.textContent = sayQueue; sayQueue = ''; lastSay = now; }
  }
  function glitch() { if (RM) return; cv.classList.remove('glitch'); void cv.offsetWidth; cv.classList.add('glitch'); }

  // ---------------- tools
  const tools = [...document.querySelectorAll('.tool[data-tool]')];
  let tool = null, drag = null, pick = null, aim = { x: 1900, y: 800, w: 800, h: 600 }, focusV = 0;
  const HINT = {
    jam: 'JAM GNSS · drag a box over the map. Keyboard: arrows move, Shift+arrows resize, Enter applies.',
    spoof: 'SPOOF GNSS · drag a box. Vehicles inside get a confident, slowly wrong position until they convict it.',
    sever: 'SEVER LINK · pick two vehicles. Keyboard: arrows choose, Enter picks.',
    destroy: 'DESTROY VEHICLE · click a vehicle. Keyboard: arrows choose, Enter destroys.',
  };
  function select(name) {
    stopDemo();
    tool = tool === name ? null : name; pick = null;
    tools.forEach(b => { if (b.dataset.tool !== 'band') b.setAttribute('aria-pressed', String(b.dataset.tool === tool)); });
    hint.textContent = tool ? HINT[tool] : 'No tool selected.';
  }
  let band = 1;
  tools.forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tool === 'band') {
      stopDemo();
      band = band === 1 ? .35 : band === .35 ? .1 : 1;
      worker.postMessage({ type: 'band', f: band }); b.setAttribute('aria-pressed', String(band < 1));
      b.textContent = band === 1 ? 'Collapse bandwidth' : `Bandwidth ${Math.round(band * 100)}%`;
      return;
    }
    select(b.dataset.tool);
  }));
  let paused = false;
  const pauseBtn = $('.tool[data-act="pause"]');
  pauseBtn.addEventListener('click', () => { paused = !paused; worker.postMessage({ type: 'pause', on: paused }); pauseBtn.setAttribute('aria-pressed', String(paused)); pauseBtn.textContent = paused ? 'Resume' : 'Pause'; });
  const restart = s => {
    jams.length = 0; spoofs.length = 0; dlog.textContent = ''; band = 1;
    const bb = $('.tool[data-tool="band"]'); bb.setAttribute('aria-pressed', 'false'); bb.textContent = 'Collapse bandwidth';
    worker.postMessage({ type: 'reset', seed: s });
  };
  $('.tool[data-act="replay"]').addEventListener('click', () => { stopDemo(); restart(seed); hint.textContent = `Replaying seed ${seed} from the start.`; });
  $('.tool[data-act="reset"]').addEventListener('click', () => { stopDemo(); select(null); restart(seed); hint.textContent = 'Reset to nominal. No adversary actions.'; });

  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  function nearest(px, py) {
    if (!cur) return -1; let best = -1, bd = 40 * 40;
    for (let i = 0; i < NV; i++) { const o = i * VF; if (!cur.snap[o + 6]) continue; const dx = wx(cur.snap[o]) - px, dy = wy(cur.snap[o + 1]) - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function applyBox(x0, y0, x1, y1) {
    if (Math.abs(x1 - x0) < 60 || Math.abs(y1 - y0) < 60) { hint.textContent = 'Box too small. Drag a larger area.'; return; }
    const cmd = { type: tool, x0, y0, x1, y1 };
    worker.postMessage(cmd); (tool === 'jam' ? jams : spoofs).push(cmd);
  }
  function applyVehicle(i) {
    if (i < 0) return;
    if (tool === 'destroy') { worker.postMessage({ type: 'destroy', i }); }
    else if (tool === 'sever') {
      if (pick === null) { pick = i; hint.textContent = `SEVER LINK · ${names[i]} picked. Now pick the other end.`; }
      else if (pick !== i) { worker.postMessage({ type: 'sever', a: pick, b: i }); hint.textContent = `${names[pick]} ↔ ${names[i]} severed. Pick another pair, or choose a different tool.`; pick = null; }
    }
  }
  cv.addEventListener('pointerdown', e => {
    if (!tool) return; const [px, py] = pos(e);
    if (tool === 'jam' || tool === 'spoof') { drag = { x0: px, y0: py, x1: px, y1: py }; cv.setPointerCapture(e.pointerId); }
    else applyVehicle(nearest(px, py));
  });
  cv.addEventListener('pointermove', e => { if (!drag) return; const [px, py] = pos(e); drag.x1 = px; drag.y1 = py; });
  cv.addEventListener('pointerup', () => { if (!drag) return; applyBox(ix(drag.x0), iy(drag.y0), ix(drag.x1), iy(drag.y1)); drag = null; });

  cv.addEventListener('keydown', e => {
    if (!tool) return;
    const box = tool === 'jam' || tool === 'spoof', step = 100;
    const k = e.key; let used = true;
    if (box) {
      if (k === 'ArrowLeft') e.shiftKey ? aim.w = Math.max(200, aim.w - step) : aim.x -= step;
      else if (k === 'ArrowRight') e.shiftKey ? aim.w += step : aim.x += step;
      else if (k === 'ArrowUp') e.shiftKey ? aim.h += step : aim.y += step;
      else if (k === 'ArrowDown') e.shiftKey ? aim.h = Math.max(200, aim.h - step) : aim.y -= step;
      else if (k === 'Enter' || k === ' ') { applyBox(aim.x - aim.w / 2, aim.y - aim.h / 2, aim.x + aim.w / 2, aim.y + aim.h / 2); hint.textContent = `${tool === 'jam' ? 'Jamming' : 'Spoofing'} applied at ${(aim.x / 1000).toFixed(1)} km east, ${(aim.y / 1000).toFixed(1)} km north.`; }
      else used = false;
      aim.x = Math.max(0, Math.min(WORLD_W, aim.x)); aim.y = Math.max(0, Math.min(WORLD_H, aim.y));
    } else {
      const alive = cur ? [...Array(NV).keys()].filter(i => cur.snap[i * VF + 6]) : [];
      if (k === 'ArrowRight' || k === 'ArrowDown') { focusV = alive[(alive.indexOf(focusV) + 1) % alive.length] ?? 0; hint.textContent = `${names[focusV]} selected. Enter to ${tool === 'destroy' ? 'destroy' : 'pick'}.`; }
      else if (k === 'ArrowLeft' || k === 'ArrowUp') { focusV = alive[(alive.indexOf(focusV) - 1 + alive.length) % alive.length] ?? 0; hint.textContent = `${names[focusV]} selected. Enter to ${tool === 'destroy' ? 'destroy' : 'pick'}.`; }
      else if (k === 'Enter' || k === ' ') applyVehicle(focusV);
      else used = false;
    }
    if (used) e.preventDefault();
  });

  // ---------------- guided demo: 20 s, then visibly hands over
  const demo = { active: false, timers: [] };
  function stopDemo() { if (!demo.active) return; demo.active = false; demo.timers.forEach(clearTimeout); demo.timers = []; hint.textContent = 'Demo stopped. You have control.'; }
  function runDemo() {
    if (RM) { hint.textContent = 'Choose an adversary control, then act on the map.'; return; }
    demo.active = true;
    const at = (s, f) => demo.timers.push(setTimeout(() => { if (demo.active) f(); }, s * 1000));
    hint.textContent = 'DEMO · nominal: twelve vehicles share thirty survey stations.';
    at(3, () => { hint.textContent = 'DEMO · jamming GNSS over the eastern land sector.'; tool = 'jam'; applyBox(1700, 150, 3100, 1100); tool = null; });
    at(7, () => { hint.textContent = 'DEMO · destroying an aircraft mid-task. Watch its stations after its lease expires.'; worker.postMessage({ type: 'destroy', i: 1 }); });
    at(12, () => { hint.textContent = 'DEMO · spoofing GNSS over the water.'; tool = 'spoof'; applyBox(1500, 1500, 3200, 2000); tool = null; });
    at(16, () => { hint.textContent = 'DEMO · collapsing bandwidth to 35%.'; band = .35; worker.postMessage({ type: 'band', f: band }); const bb = $('.tool[data-tool="band"]'); bb.setAttribute('aria-pressed', 'true'); bb.textContent = 'Bandwidth 35%'; });
    at(20, () => { demo.active = false; hint.textContent = 'YOUR TURN · the controls are live. Break it.'; $('#rig').classList.add('handover'); });
  }
  let demoStarted = false;
  watch(cv, v => { if (v && !demoStarted) { demoStarted = true; setTimeout(runDemo, 600); } }, false);

  // ---------------- render: interpolate between the last two snapshots
  const lerp = (a, b, k) => a + (b - a) * k;
  function draw(now) {
    requestAnimationFrame(draw);
    if (!cur) return;
    const k = prev ? Math.min(1, (now - curAt) / 50) : 1;
    const S = cur.snap, P = prev ? prev.snap : S;
    ctx.drawImage(terrain, 0, 0);
    // adversary regions
    for (const r of jams) { ctx.fillStyle = 'rgba(255,74,43,.08)'; ctx.fillRect(wx(r.x0), wy(r.y1), (r.x1 - r.x0) * K, (r.y1 - r.y0) * K); ctx.strokeStyle = '#ff4a2b'; ctx.setLineDash([]); ctx.strokeRect(wx(r.x0), wy(r.y1), (r.x1 - r.x0) * K, (r.y1 - r.y0) * K); ctx.fillStyle = '#ff4a2b'; ctx.font = '12px "IBM Plex Mono", monospace'; ctx.fillText('GNSS JAMMED', wx(r.x0) + 6, wy(r.y1) + 16); }
    for (const r of spoofs) { ctx.strokeStyle = '#ff4a2b'; ctx.setLineDash([6, 5]); ctx.strokeRect(wx(r.x0), wy(r.y1), (r.x1 - r.x0) * K, (r.y1 - r.y0) * K); ctx.setLineDash([]); ctx.fillStyle = '#ff4a2b'; ctx.font = '12px "IBM Plex Mono", monospace'; ctx.fillText('GNSS SPOOFED', wx(r.x0) + 6, wy(r.y1) + 16); }
    // allocation round sweep: consensus runs every 2 simulated seconds
    const ph = (cur.t % 2) / 2; ctx.strokeStyle = 'rgba(242,240,234,.07)'; ctx.beginPath(); ctx.moveTo(ph * W, 0); ctx.lineTo(ph * W, H); ctx.stroke();
    // links
    const base = NV * VF + nt * 4;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(166,164,157,.16)';
    ctx.beginPath();
    for (let i = 0; i < NV; i++) for (let j = i + 1; j < NV; j++) if (S[base + i * NV + j] || S[base + j * NV + i]) {
      ctx.moveTo(wx(lerp(P[i * VF], S[i * VF], k)), wy(lerp(P[i * VF + 1], S[i * VF + 1], k)));
      ctx.lineTo(wx(lerp(P[j * VF], S[j * VF], k)), wy(lerp(P[j * VF + 1], S[j * VF + 1], k)));
    }
    ctx.stroke();
    // stations
    for (let t = 0; t < nt; t++) {
      const o = NV * VF + t * 4, x = wx(S[o]), y = wy(S[o + 1]), st = S[o + 2];
      if (st === 2) { ctx.fillStyle = '#3a3a36'; ctx.fillRect(x - 5, y - 5, 10, 10); }
      else { ctx.strokeStyle = st === 1 ? '#a6a49d' : '#55544f'; ctx.lineWidth = 1.2; ctx.strokeRect(x - 6, y - 6, 12, 12); }
    }
    // assignment lines and vehicles
    ctx.font = '11px "IBM Plex Mono", monospace';
    for (let i = 0; i < NV; i++) {
      const o = i * VF, alive = S[o + 6];
      const x = wx(lerp(P[o], S[o], k)), y = wy(lerp(P[o + 1], S[o + 1], k));
      if (!alive) { ctx.strokeStyle = '#ff4a2b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke(); ctx.fillStyle = '#ff4a2b'; ctx.fillText(names[i], x + 10, y - 8); continue; }
      const rung = S[o + 7], sigma = S[o + 4], tx = S[o + 10], ty = S[o + 11];
      if (tx >= 0) { ctx.strokeStyle = 'rgba(242,240,234,.22)'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(wx(tx), wy(ty)); ctx.stroke(); ctx.setLineDash([]); }
      // where it BELIEVES it is, and how sure: the gap is the navigation error
      const bx = wx(lerp(P[o + 2], S[o + 2], k)), by = wy(lerp(P[o + 3], S[o + 3], k));
      if (sigma > 8) { ctx.strokeStyle = rung >= 3 || S[o + 13] ? 'rgba(255,74,43,.7)' : 'rgba(166,164,157,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(bx, by, Math.max(4, sigma * K), 0, Math.PI * 2); ctx.stroke(); }
      if (Math.hypot(bx - x, by - y) > 3) { ctx.strokeStyle = 'rgba(255,74,43,.55)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by); ctx.stroke(); }
      const col = rung === 0 ? '#f2f0ea' : rung >= 3 ? '#ff4a2b' : '#a6a49d';
      ctx.fillStyle = col; ctx.save(); ctx.translate(x, y);
      const kind = S[o + 9];
      if (kind === 0) { ctx.rotate(-S[o + 5]); ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-7, -7); ctx.lineTo(-3, 0); ctx.lineTo(-7, 7); ctx.closePath(); ctx.fill(); }
      else if (kind === 1) ctx.fillRect(-6, -6, 12, 12);
      else { ctx.rotate(Math.PI / 4); ctx.fillRect(-5, -5, 10, 10); }
      ctx.restore();
      if (tool && (tool === 'destroy' || tool === 'sever') && (i === focusV || i === pick) && document.activeElement === cv) { ctx.strokeStyle = '#ff4a2b'; ctx.lineWidth = 2; ctx.strokeRect(x - 14, y - 14, 28, 28); }
      ctx.fillStyle = rung === 0 ? '#a6a49d' : col; ctx.fillText(names[i] + (rung ? ` ${RUNG[rung]}` : ''), x + 12, y - 9);
    }
    // aim box (keyboard) or drag box (pointer)
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff4a2b'; ctx.setLineDash([4, 4]);
    if (drag) ctx.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    else if ((tool === 'jam' || tool === 'spoof') && document.activeElement === cv) ctx.strokeRect(wx(aim.x - aim.w / 2), wy(aim.y + aim.h / 2), aim.w * K, aim.h * K);
    ctx.setLineDash([]);
    if (paused) { ctx.fillStyle = '#f2f0ea'; ctx.font = '13px "IBM Plex Mono", monospace'; ctx.fillText('PAUSED', W - 80, 24); }
  }
  requestAnimationFrame(draw);
  window.__live = { frames: () => frames, seed: () => seed, hash: () => cur && cur.hash };
}
