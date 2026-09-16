// "Fly the mission yourself": renders the cross-domain swarm posted by mission-worker.js and owns every
// control around it -- scenarios, transport, timeline (exact rewind), zoom/pan, failure injection, drawn
// jamming zones, the movable rendezvous, keyboard shortcuts, hover read-outs -- and the Turtle Eyes console.
// It never decides anything about the swarm; every state it draws comes from the worker.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const UF = 26, LF = 8;
const PHASE = ['LAUNCH', 'ASSEMBLY', 'FORMATION', 'TRANSIT', 'SPLIT', 'SEARCH', 'RENDEZVOUS', 'REFORM', 'RETURN', 'COMPLETE'];
const FORM = ['WEDGE', 'V', 'LINE', 'COLUMN', 'SEARCH', 'RING'];
const STATE = ['READY', 'ACTIVE', 'LEFT FORMATION', 'REJOINING', 'COMMS LOST', 'LOST', 'HOME'];
const RUNG = ['NOMINAL', 'DEGRADED NAV', 'DEGRADED COMMS', 'ISOLATED', 'LOST'];
const REGIME = ['CONSENSUS', 'PAIRED', 'SOLO', 'ORPHAN'];
const NAV = ['UNKNOWN', 'GPS', 'VIO', 'TERRAIN', 'PEER RANGING', 'DEAD RECKONING', 'FUSED'];
const KIND = ['Fixed-wing aircraft', 'Ground robot', 'Surface boat'];
const SPEED = { 0.5: 15, 1: 30, 2: 60, 4: 120 };
const SKIP = { 1: [1, 2, 4, 6, 7], 2: [4, 5, 6, 7] };
const ABOUT = {
  1: 'One aircraft, alone. With no peers TurtleShield marks it ISOLATED, so it may fly only its pre-loaded plan. GPS drops out on the way.',
  2: 'Eight aircraft: a wedge, a column through the corridor, a V, and one aircraft leaving formation for a sensor check, then rejoining.',
  3: 'Seventy aircraft, six ground robots and four boats fly the whole mission with nothing going wrong. Watch the split, the lanes over land and water, and the relay rings.',
  4: 'GPS is denied over the transit corridor. Vehicles fall back to inertial and ranging off their peers, and the formation widens as uncertainty grows.',
  5: 'Radio links degrade in transit and U07 loses its link entirely. It follows the isolation policy, then rejoins when the link returns.',
  6: 'The lead aircraft is lost in transit, then two working aircraft and a working ground robot during the search. Leadership passes on and the survivors take over their lanes and station.',
  7: 'Everything at once: GPS denial, degraded radio, a comms loss, an aircraft leaving formation, a lost aircraft and a lost ground robot, and a commanded formation change.',
};
const C = { bg: '#0b0d10', fg: '#e9e5dc', steel: '#a3a8ae', quiet: '#868c93', tan: '#c4a574', red: '#ff4632', redBtn: '#c42a1c', grid: 'rgba(233,229,220,.035)' };
const WORLD = { x0: 0, y0: 0, x1: 27000, y1: 13500 };
const pad2 = n => String(n).padStart(2, '0');
const clock = t => `T+${pad2(Math.floor(t / 60))}:${pad2(Math.floor(t % 60))}`;

export function startLive({ cue, RM }) {
  const cv = $('#map'), ctx = cv.getContext('2d'), hint = $('#tool-hint'), dlog = $('#dlog'), narrate = $('#narrate');
  const tl = $('#tl'), tlOut = $('#tl-out');
  const q = new URLSearchParams(location.search);
  let scenario = Math.min(7, Math.max(1, parseInt(q.get('scenario'), 10) || 7));
  let seed = Math.max(1, Math.min(999999, parseInt(q.get('seed'), 10) || 11));
  let atOnce = Math.max(0, Math.min(5000, parseFloat(q.get('at')) || 0));
  let W = cv.width, H = cv.height;
  let prev = null, cur = null, curAt = 0, frames = 0, G = null;
  let playing = true, follow = true, eng = q.get('eng') === '1', selected = -1, hover = -1, speedKey = RM ? 0.5 : 1, tool = null;
  const cam = { x: 9000, y: 6000, s: .05, tx: 9000, ty: 6000, ts: .05 };
  const trails = []; let lastTrailT = -1e9;
  let pendingId = 0, demoTimer = null, rosterBuilt = 0, lastConsole = 0, scrubbing = false, endT = 4200;
  const nameOf = (i, S) => { const k = S[i * UF + 24]; if (k === 0) return `U${pad2(i + 1)}`; let g = 0, s = 0; for (let j = 0; j < i; j++) { const kk = S[j * UF + 24]; if (kk === 1) g++; if (kk === 2) s++; } return k === 1 ? `G${pad2(g + 1)}` : `S${pad2(s + 1)}`; };

  // ---------------- canvas size follows its CSS box
  const fit = () => { const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); W = cv.width = Math.max(320, Math.round(r.width * d)); H = cv.height = Math.max(200, Math.round(r.height * d)); };
  new ResizeObserver(fit).observe(cv); fit();

  // ---------------- terrain: gunmetal relief, water north-east, drawn once
  const TS = .12, terr = document.createElement('canvas');
  terr.width = Math.round((WORLD.x1 - WORLD.x0) * TS); terr.height = Math.round((WORLD.y1 - WORLD.y0) * TS);
  let terrDrawn = false;
  function drawTerrain() {
    const t = terr.getContext('2d'); t.fillStyle = '#0d0f12'; t.fillRect(0, 0, terr.width, terr.height);
    t.fillStyle = '#0a1219'; t.fillRect(G[23] * TS, 0, terr.width, (WORLD.y1 - G[24]) * TS);
    t.strokeStyle = '#1d3040'; t.lineWidth = 2; t.beginPath(); t.moveTo(G[23] * TS, (WORLD.y1 - G[24]) * TS); t.lineTo(terr.width, (WORLD.y1 - G[24]) * TS); t.moveTo(G[23] * TS, 0); t.lineTo(G[23] * TS, (WORLD.y1 - G[24]) * TS); t.stroke();
    const hills = [[4000, 9000, 1.4], [7000, 1500, 1], [11500, 3200, .9], [11500, 7300, .9], [9500, 11000, .9], [3000, 12000, 1.1], [26000, 1500, 1], [17500, 2200, .9], [21500, 5200, .8]];
    t.lineWidth = 1;
    for (const [hx, hy, k] of hills) for (let ring = 1; ring < 9; ring++) {
      t.strokeStyle = ring % 4 === 0 ? '#23272d' : '#181b20'; t.beginPath();
      for (let a = 0; a <= 72; a++) {
        const th = a / 72 * Math.PI * 2, r = ring * 170 * k * (1 + .18 * Math.sin(3 * th + hx) + .08 * Math.cos(5 * th + hy));
        const px = (hx + Math.cos(th) * r) * TS, py = (WORLD.y1 - (hy + Math.sin(th) * r)) * TS;
        a ? t.lineTo(px, py) : t.moveTo(px, py);
      }
      t.stroke();
    }
    terrDrawn = true;
  }
  const sx = x => (x - cam.x) * cam.s + W / 2, sy = y => H / 2 - (y - cam.y) * cam.s;
  const wx = px => (px - W / 2) / cam.s + cam.x, wy = py => cam.y - (py - H / 2) / cam.s;
  const dpr = () => Math.min(devicePixelRatio || 1, 2);

  // ---------------- worker
  const worker = new Worker(new URL('./mission-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'frame') {
      if (m.geom) { G = m.geom; if (!terrDrawn) drawTerrain(); }
      prev = cur && cur.n === m.n ? cur : null; cur = m; curAt = performance.now(); frames++;
      if (m.log) ingest(m.log);
      if (m.meta[18] > 0) endT = Math.max(endT, m.meta[18]);
      if (!scrubbing) { tl.max = String(Math.ceil(endT / 10) * 10); tl.value = String(Math.round(m.meta[0])); tlOut.textContent = clock(m.meta[0]); }
      consoleUpdate();
    } else if (m.type === 'ready') hint.textContent = ABOUT[scenario];
    else if (m.type === 'seeked') { trails.length = 0; lastTrailT = -1e9; dlog.textContent = ''; addLine(`Timeline moved to ${clock(m.t)}. Replaying from the simulation's own saved state.`, 'op'); scrubbing = false; }
    else if (m.type === 'error') hint.textContent = `Simulation error: ${m.message}`;
  };
  const start = () => {
    prev = cur = null; trails.length = 0; lastTrailT = -1e9; dlog.textContent = ''; selected = -1; rosterBuilt = 0; pendingId = 0; endT = 4200;
    clearTimeout(demoTimer); demoTimer = null; if (tool) setTool(tool);
    worker.postMessage({ type: 'init', scenario, seed, at: atOnce });
    if (atOnce) { const t = atOnce; setTimeout(() => addLine(`Fast-forwarded to ${clock(t)}; decisions on the way were confirmed by the demo operator`, 'op'), 400); }
    atOnce = 0; phaseRibbon(0);
  };
  worker.postMessage({ type: 'speed', v: SPEED[speedKey] });

  // ---------------- scenario selector (radio group)
  const scen = $$('.scen [role="radio"]');
  const pickScen = (b, focus) => { scen.forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; }); if (focus) b.focus(); scenario = +b.dataset.scen; start(); };
  scen.forEach(b => { b.tabIndex = +b.dataset.scen === scenario ? 0 : -1; b.setAttribute('aria-checked', String(+b.dataset.scen === scenario)); });
  scen.forEach((b, i) => {
    b.addEventListener('click', () => pickScen(b, false));
    b.addEventListener('keydown', e => { let j = -1; const k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % scen.length; else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + scen.length) % scen.length; else if (k === 'Home') j = 0; else if (k === 'End') j = scen.length - 1;
      if (j >= 0) { e.preventDefault(); pickScen(scen[j], true); } });
  });

  // ---------------- transport, timeline, zoom
  const btn = s => $(`.transport [data-act="${s}"]`);
  const setPlaying = on => { playing = on; worker.postMessage({ type: 'play', on }); btn('play').setAttribute('aria-pressed', String(on)); btn('play').textContent = on ? 'Pause' : 'Play'; };
  btn('play').addEventListener('click', () => setPlaying(!playing));
  btn('step').addEventListener('click', () => { if (playing) setPlaying(false); worker.postMessage({ type: 'step', sec: 1 }); });
  btn('restart').addEventListener('click', () => { start(); hint.textContent = `Restarted: ${ABOUT[scenario]}`; });
  const setFollow = on => { follow = on; btn('follow').setAttribute('aria-pressed', String(on)); };
  btn('follow').addEventListener('click', () => setFollow(!follow));
  const zoom = f => { cam.ts = Math.max(.008, Math.min(.6, cam.ts * f)); setFollow(false); };
  btn('zoomin').addEventListener('click', () => zoom(1.4)); btn('zoomout').addEventListener('click', () => zoom(1 / 1.4));
  const setEng = on => { eng = on; btn('eng').setAttribute('aria-pressed', String(on)); hint.textContent = on ? 'Engineering view: velocity (solid), homing vector (dashed), formation slot (dotted to square), navigation uncertainty (circle), comm links, separation layers.' : ABOUT[scenario]; };
  btn('eng').setAttribute('aria-pressed', String(eng));
  btn('eng').addEventListener('click', () => setEng(!eng));
  const speeds = $$('.speed [role="radio"]');
  const setSpeed = (b, focus) => { speedKey = +b.dataset.speed; speeds.forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; }); if (focus) b.focus(); worker.postMessage({ type: 'speed', v: SPEED[speedKey] }); };
  speeds.forEach((b, i) => {
    b.tabIndex = +b.dataset.speed === speedKey ? 0 : -1; b.setAttribute('aria-checked', String(+b.dataset.speed === speedKey));
    b.addEventListener('click', () => setSpeed(b, false));
    b.addEventListener('keydown', e => { let j = -1; if (e.key === 'ArrowRight') j = (i + 1) % speeds.length; else if (e.key === 'ArrowLeft') j = (i - 1 + speeds.length) % speeds.length; if (j >= 0) { e.preventDefault(); setSpeed(speeds[j], true); } });
  });
  tl.addEventListener('input', () => { scrubbing = true; tlOut.textContent = clock(+tl.value); });
  tl.addEventListener('change', () => { worker.postMessage({ type: 'seek', t: +tl.value }); hint.textContent = `Moving the timeline to ${clock(+tl.value)}…`; });

  // ---------------- failures and map tools
  const E = { GPS_ON: 1, GPS_OFF: 2, RADIO_ON: 3, RADIO_OFF: 4, CUT: 5, LOSE: 6, LEAVE: 7, FORM: 8 };
  const need = what => { if (selected < 0) { hint.textContent = `Select a vehicle first (click it on the map, or in the Fleet list), then ${what}.`; return false; } return true; };
  const ev = (kind, arg = 0) => worker.postMessage({ type: 'event', kind, arg });
  const act = name => {
    const me = cur && cur.meta; if (!me) return;
    switch (name) {
      case 'gps': ev(me[15] ? E.GPS_OFF : E.GPS_ON); break;
      case 'radio': ev(me[16] ? E.RADIO_OFF : E.RADIO_ON); break;
      case 'cut': if (need('cut its comms')) ev(E.CUT, selected); break;
      case 'leave': if (need('send it out of formation')) ev(E.LEAVE, selected); break;
      case 'lose': if (need('remove it')) ev(E.LOSE, selected); break;
      case 'form': ev(E.FORM, Math.max(selected, 0)); break;
      case 'clearzones': worker.postMessage({ type: 'zonesClear' }); break;
    }
  };
  $$('.inject [data-ev]').forEach(b => b.addEventListener('click', () => act(b.dataset.ev)));
  const toolBtns = $$('.inject [data-tool]');
  function setTool(name) {
    tool = tool === name ? null : name;
    toolBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    cv.classList.toggle('tool-zone', tool === 'zone'); cv.classList.toggle('tool-rdv', tool === 'rdv');
    if (tool === 'zone') hint.textContent = 'DRAW JAMMING ZONE · drag a box on the map. Every vehicle inside loses GPS. Up to six zones.';
    else if (tool === 'rdv') hint.textContent = 'MOVE RENDEZVOUS · click where the groups should meet after the search.';
  }
  toolBtns.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  // ---------------- pointer: select, hover, pan, draw, place; pinch zoom on touch
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  const nearest = (px, py, radius) => {
    if (!cur) return -1; let best = -1, bd = radius;
    for (let i = 0; i < cur.n; i++) { const st = cur.snap[i * UF + 7]; if (st === 0 || st === 6) continue; const d = Math.hypot(sx(cur.snap[i * UF]) - px, sy(cur.snap[i * UF + 1]) - py); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  let drag = null; const touches = new Map(); let pinch0 = 0;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, pos(e));
    if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); drag = null; return; }
    const p = pos(e);
    drag = { p, cur: p, cx: cam.x, cy: cam.y, moved: false, mode: tool === 'zone' ? 'zone' : 'pan' };
  });
  cv.addEventListener('pointermove', e => {
    const p = pos(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
    if (touches.size === 2) { const [a, b] = [...touches.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0 > 0) { cam.ts = cam.s = Math.max(.008, Math.min(.6, cam.s * d / pinch0)); pinch0 = d; setFollow(false); } return; }
    if (!drag) { hover = nearest(p[0], p[1], 22 * dpr()); return; }
    drag.cur = p;
    if (Math.hypot(p[0] - drag.p[0], p[1] - drag.p[1]) > 6) drag.moved = true;
    if (drag.moved && drag.mode === 'pan') { setFollow(false); cam.x = cam.tx = drag.cx - (p[0] - drag.p[0]) / cam.s; cam.y = cam.ty = drag.cy + (p[1] - drag.p[1]) / cam.s; }
  });
  const endPointer = e => {
    touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0;
    if (!drag || !cur) { drag = null; return; }
    const p = drag.cur;
    if (drag.mode === 'zone' && drag.moved) {
      worker.postMessage({ type: 'zone', x0: wx(drag.p[0]), y0: wy(drag.p[1]), x1: wx(p[0]), y1: wy(p[1]) });
      hint.textContent = 'Jamming zone drawn. Watch vehicles inside switch to inertial and peer ranging.'; glitch(); cue('tick');
    } else if (!drag.moved) {
      if (tool === 'rdv') { worker.postMessage({ type: 'rdv', x: wx(p[0]), y: wy(p[1]) }); setTool('rdv'); hint.textContent = 'Rendezvous moved. It applies until the groups start meeting.'; }
      else { const i = nearest(p[0], p[1], 30 * dpr()); select(i === selected ? -1 : i); }
    }
    drag = null;
  };
  cv.addEventListener('pointerup', endPointer); cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('pointerleave', () => { hover = -1; });
  cv.addEventListener('dblclick', e => { const [px, py] = pos(e); cam.tx = wx(px); cam.ty = wy(py); cam.ts = Math.max(.008, Math.min(.6, cam.s * (e.shiftKey ? .6 : 1.7))); setFollow(false); });

  // ---------------- keyboard shortcuts (map focused)
  cv.addEventListener('keydown', e => {
    if (!cur || e.ctrlKey || e.metaKey || e.altKey) return;
    const alive = [...Array(cur.n).keys()].filter(i => { const st = cur.snap[i * UF + 7]; return st > 0 && st < 5; });
    const k = e.key; let used = true;
    if (k === ' ') setPlaying(!playing);
    else if (k === 'ArrowRight' || k === 'ArrowDown') select(alive[(alive.indexOf(selected) + 1) % alive.length] ?? -1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') select(alive[(alive.indexOf(selected) - 1 + alive.length) % alive.length] ?? -1);
    else if (k === '+' || k === '=') zoom(1.4);
    else if (k === '-' || k === '_') zoom(1 / 1.4);
    else if (k === 'Escape') { select(-1); if (tool) setTool(tool); }
    else if (/^[1-7]$/.test(k)) pickScen(scen[+k - 1], false);
    else if (k === 'e' || k === 'E') setEng(!eng);
    else if (k === 'f' || k === 'F') setFollow(!follow);
    else if (k === 'g' || k === 'G') act('gps');
    else if (k === 'r' || k === 'R') act('radio');
    else if (k === 'c' || k === 'C') act('cut');
    else if (k === 'l' || k === 'L') act('lose');
    else if (k === 'v' || k === 'V') act('leave');
    else if (k === 't' || k === 'T') act('form');
    else if (k === 'z' || k === 'Z') setTool('zone');
    else used = false;
    if (used) e.preventDefault();
  });
  function select(i) {
    selected = i;
    $$('#roster button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.u === i)));
    if (i >= 0 && cur) hint.textContent = `${nameOf(i, cur.snap)} selected. Its telemetry is in the Turtle Eyes console; failures marked "selected" act on it.`;
    consoleUpdate(true);
  }

  // ---------------- decision: hold to confirm, or the clearly labelled demo operator
  const hold = $('#hold'), holdHint = $('#hold-hint'), rec = $('#rec'), recText = $('#rec-text'), demoOp = $('#demo-op');
  let holding = false, hp = 0, ht0 = 0, armed = 0, lastGesture = 0;
  const confirmNow = who => {
    if (!pendingId) return;
    worker.postMessage({ type: 'confirm', id: pendingId });
    addLine(`OPERATOR  ${who}`, 'op'); clearTimeout(demoTimer); demoTimer = null;
    hold.disabled = true; releaseVisual(); holdHint.textContent = who.startsWith('DEMO') ? 'Confirmed by the demo operator.' : 'Confirmed.';
  };
  function holdFrame() { if (!holding) return; hp = Math.max(0, Math.min(1, (performance.now() - ht0) / 1100)); hold.style.setProperty('--p', hp); if (hp >= 1) { holding = false; confirmNow('confirmed by you (held)'); return; } requestAnimationFrame(holdFrame); }
  const releaseVisual = () => { hold.classList.add('rel'); hold.style.setProperty('--p', 0); hp = 0; };
  const startHold = e => { if (hold.disabled || holding) return; if (e && e.preventDefault) e.preventDefault(); lastGesture = performance.now();
    if (demoOp.checked) { demoOp.checked = false; clearTimeout(demoTimer); demoTimer = null; }
    holding = true; hold.classList.remove('rel'); ht0 = performance.now(); holdHint.textContent = 'Keep holding…'; requestAnimationFrame(holdFrame); };
  const endHold = () => { if (!holding) return; holding = false; releaseVisual(); if (!hold.disabled) holdHint.textContent = 'Let go too early. Hold for about a second.'; };
  hold.addEventListener('pointerdown', startHold);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(x => hold.addEventListener(x, endHold));
  hold.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) startHold(e); });
  hold.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') endHold(); });
  hold.addEventListener('contextmenu', e => e.preventDefault());
  hold.addEventListener('blur', endHold); addEventListener('blur', endHold);                  // a hold never completes itself
  document.addEventListener('visibilitychange', () => { if (document.hidden) endHold(); });
  hold.addEventListener('click', e => {                                                        // screen readers: two activations
    if (hold.disabled || e.detail !== 0 || performance.now() - lastGesture < 1500) return;
    if (armed === pendingId) { armed = 0; confirmNow('confirmed by you (two activations)'); return; }
    armed = pendingId; holdHint.textContent = 'Activate again to confirm this decision.';
  });
  demoOp.addEventListener('change', () => { if (!demoOp.checked) { clearTimeout(demoTimer); demoTimer = null; } else armDemo(); });
  function armDemo() {
    if (!pendingId || !demoOp.checked || demoTimer) return;
    demoTimer = setTimeout(() => { demoTimer = null; if (demoOp.checked && pendingId) confirmNow('DEMO OPERATOR confirmed after 6 s (untick "Demo operator" to decide yourself)'); }, 6000);
  }

  // ---------------- console
  const set = (id, v, cls) => { const el = $(id); if (!el) return; if (el.textContent !== String(v)) el.textContent = v; if (cls !== undefined && el.className !== cls) el.className = cls; };
  function consoleUpdate(force) {
    if (!cur) return;
    const now = performance.now(); if (!force && now - lastConsole < 200) return; lastConsole = now;
    const me = cur.meta, n = cur.n, S = cur.snap;
    set('#sim-clock', clock(me[0]));
    set('#s-fw', `${me[31]}/${me[28]}`); set('#s-gnd', `${me[32]}/${me[29]}`); set('#s-sea', `${me[33]}/${me[30]}`);
    set('#s-act', me[8]); set('#s-relay', me[34]); set('#s-rej', me[9] + me[13], me[9] + me[13] ? 'warn' : '');
    set('#s-cl', me[10], me[10] ? 'bad' : ''); set('#s-lost', me[11], me[11] ? 'bad' : ''); set('#s-land', me[12]);
    const ph = me[1], CH = { 3: [2, 3, 4], 5: [5], 6: [6, 7], 8: [8, 9] };
    $$('#chain span').forEach(s => { const g = CH[+s.dataset.p]; s.className = g.includes(ph) ? 'on' : ph > Math.max(...g) ? 'done' : ''; });
    const lead = i => i >= 0 ? `LEADER U${pad2(i + 1)}` : 'NO LEADER';
    set('#ga-n', `${me[4]} aircraft${me[30] && me[21] ? ` + ${me[33]} boats` : ''}`); set('#ga-f', FORM[me[2]] || '–'); set('#ga-l', lead(me[6]));
    set('#gb-n', me[21] ? `${me[5]} aircraft${me[29] ? ` + ${me[32]} robots` : ''}` : 'not split'); set('#gb-f', me[21] ? (FORM[me[3]] || '–') : '–'); set('#gb-l', me[21] ? lead(me[7]) : '–');
    $$('.grp')[1].classList.toggle('off', !me[21]);
    const pid = me[17];
    if (pid !== pendingId) {
      pendingId = pid; armed = 0;
      if (pid) { rec.classList.add('live-dec'); recText.textContent = cur.decision; hold.disabled = false; holdHint.textContent = ''; armDemo(); cue('tick'); narrate.textContent = `Awaiting operator: ${cur.decision}`; }
      else { rec.classList.remove('live-dec'); recText.textContent = ph === 9 ? 'Mission complete. Nothing pending.' : 'No decision pending. The swarm is executing the plan.'; hold.disabled = true; }
    }
    $('.inject [data-ev="gps"]').setAttribute('aria-pressed', String(!!me[15]));
    $('.inject [data-ev="radio"]').setAttribute('aria-pressed', String(!!me[16]));
    if (rosterBuilt !== n) {
      const r = $('#roster'); r.textContent = '';
      let lastKind = -1;
      for (let i = 0; i < n; i++) {
        const kind = S[i * UF + 24];
        if (kind !== lastKind) { const h = document.createElement('span'); h.className = 'roster-k'; h.textContent = ['Air', 'Ground', 'Surface'][kind]; r.appendChild(h); lastKind = kind; }
        const b = document.createElement('button'); b.type = 'button'; b.dataset.u = i; b.textContent = nameOf(i, S).replace(/^U/, ''); b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => select(+b.dataset.u === selected ? -1 : i)); r.appendChild(b);
      }
      rosterBuilt = n;
    }
    $$('#roster button').forEach(b => {
      const i = +b.dataset.u, o = i * UF, st = S[o + 7];
      const c = st === 3 || st === 2 ? 'rej' : st === 4 ? 'cl' : st === 5 ? 'lost' : st === 6 ? 'land' : S[o + 5] === 1 && S[o + 24] === 0 ? 'b' : '';
      if (b.className !== c) b.className = c;
      const label = `${nameOf(i, S)}, ${KIND[S[o + 24]].toLowerCase()}, ${STATE[st].toLowerCase()}${S[o + 6] ? ', group leader' : ''}`;
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    });
    const tele = $('#tele');
    if (selected < 0 || selected >= n) { if (tele.dataset.u !== '-1') { tele.dataset.u = '-1'; tele.innerHTML = '<div><dt>Selected</dt><dd>none</dd></div>'; } }
    else {
      const o = selected * UF, st = S[o + 7], kind = S[o + 24];
      const rows = [
        ['ID', nameOf(selected, S)], ['Type', ['FIXED-WING', 'GROUND', 'SURFACE'][kind]], ['Group', S[o + 5] ? 'B' : 'A'], ['Role', S[o + 6] ? 'LEADER' : S[o + 25] ? 'RELAY' : S[o + 20] >= 0 ? 'TASKED' : 'FOLLOWER'],
        ['State', STATE[st], st >= 4 && st < 6 ? 'bad' : ''], ['Speed', `${S[o + 4].toFixed(1)} m/s`], ['Heading', `${String(Math.round(((90 - S[o + 3] * 57.2958) % 360 + 360) % 360)).padStart(3, '0')}°`],
        ['Altitude', kind ? '–' : `${Math.round(S[o + 2])} m`], ['Sep. layer', kind ? '–' : S[o + 19] ? `L${S[o + 19]} +${S[o + 19] * 40} m` : 'base'],
        ['Nav', NAV[S[o + 9]] || '?', S[o + 9] === 5 ? 'bad' : ''], ['Nav 1σ', `${Math.round(S[o + 8])} m`],
        ['Ladder', RUNG[S[o + 10]] || '?', S[o + 10] >= 3 ? 'bad' : ''], ['Quorum', REGIME[S[o + 11]] || '?'],
        ['Link', `${Math.round(S[o + 12] * 100)}% peers`, S[o + 12] < .5 ? 'bad' : ''], ['Slot err', S[o + 15] >= 0 ? `${Math.round(Math.hypot(S[o + 15] - S[o], S[o + 16] - S[o + 1]))} m` : '–'],
        ['Task', S[o + 20] >= 0 ? `${S[n * UF + n * n + S[o + 20] * LF + 7] ? 'station' : 'lane'} ${S[o + 20] + 1}` : '–'],
      ];
      tele.dataset.u = selected;
      tele.innerHTML = rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd></div>`).join('');
    }
    phaseRibbon(ph);
  }
  function phaseRibbon(ph) {
    $$('#phases li').forEach((li, i) => {
      const skip = (SKIP[scenario] || []).includes(i);
      li.className = skip ? 'skip' : i === ph ? 'on' : i < ph ? 'done' : '';
      if (i === ph) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  // ---------------- log
  let lastSay = 0, sayQueue = '';
  function addLine(text, cls) {
    const li = document.createElement('li'), b = document.createElement('b');
    b.textContent = clock(cur ? cur.meta[0] : 0); li.append(b, text); if (cls) li.className = cls; dlog.prepend(li);
  }
  function ingest(text) {
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n').filter(Boolean)) {
      if (/launched$|lane complete$|landed$|station held$|online at (FOB|harbour)$/.test(line) && !/vehicles/.test(line)) continue;
      const li = document.createElement('li'), b = document.createElement('b'), body = line.slice(8);
      b.textContent = line.slice(0, 7); li.append(b, body);
      if (/^EVENT|COMMS LOST|declared DEAD/.test(body)) li.className = 'adv';
      else if (/OPERATOR/.test(body)) li.className = 'op';
      else if (/took (lane|station)|back in slot|link restored|MISSION COMPLETE|GPS restored|GPS available|RENDEZVOUS/.test(body)) li.className = 'good';
      frag.prepend(li);
      if (/^EVENT .*lost|declared DEAD/.test(body)) { glitch(); cue('impact'); sayQueue = body; }
      else if (/^EVENT|COMMS LOST/.test(body)) { glitch(); cue('tick'); sayQueue = body; }
      else if (/^PHASE|took (lane|station)|link restored|MISSION COMPLETE|leader U/.test(body)) { cue('good'); sayQueue = body; }
    }
    dlog.prepend(frag);
    while (dlog.children.length > 220) dlog.lastChild.remove();
    const now = performance.now();
    if (sayQueue && now - lastSay > 2500) { narrate.textContent = sayQueue; sayQueue = ''; lastSay = now; }
  }
  function glitch() { if (RM) return; cv.classList.remove('glitch'); void cv.offsetWidth; cv.classList.add('glitch'); }

  // ---------------- drawing
  const lerp = (a, b, k) => a + (b - a) * k;
  const WING = [[1, 0], [.25, .1], [.06, .92], [-.12, .92], [-.22, .1], [-.62, .08], [-.74, .38], [-.86, .38], [-.8, 0]];
  function plane(x, y, hd, z, fill, stroke) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-hd); ctx.beginPath();
    WING.forEach(([u, v], i) => i ? ctx.lineTo(u * z, v * z) : ctx.moveTo(u * z, v * z));
    for (let i = WING.length - 2; i > 0; i--) ctx.lineTo(WING[i][0] * z, -WING[i][1] * z);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.3 * dpr(); ctx.stroke(); }
    ctx.restore();
  }
  function rover(x, y, hd, z, fill, stroke) { ctx.save(); ctx.translate(x, y); ctx.rotate(-hd); ctx.fillStyle = fill; ctx.fillRect(-z * .8, -z * .55, z * 1.6, z * 1.1); ctx.fillStyle = C.bg; ctx.fillRect(z * .3, -z * .2, z * .35, z * .4); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.3 * dpr(); ctx.strokeRect(-z * .8, -z * .55, z * 1.6, z * 1.1); } ctx.restore(); }
  function boat(x, y, hd, z, fill, stroke) { ctx.save(); ctx.translate(x, y); ctx.rotate(-hd); ctx.beginPath(); ctx.moveTo(z * 1.1, 0); ctx.lineTo(z * .2, -z * .5); ctx.lineTo(-z * .9, -z * .45); ctx.lineTo(-z * .9, z * .45); ctx.lineTo(z * .2, z * .5); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.3 * dpr(); ctx.stroke(); } ctx.restore(); }
  function arrow(x0, y0, x1, y1, col, dash) {
    const a = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0); if (L < 4) return;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.setLineDash(dash || []); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - Math.cos(a - .45) * 7, y1 - Math.sin(a - .45) * 7); ctx.lineTo(x1 - Math.cos(a + .45) * 7, y1 - Math.sin(a + .45) * 7); ctx.closePath(); ctx.fill();
  }
  function hull(pts) {
    if (pts.length < 3) return pts;
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function label(txt, x, y, col, size = 11) { ctx.font = `${size * dpr()}px "IBM Plex Mono", monospace`; ctx.fillStyle = col; ctx.fillText(txt, x, y); }
  function rectW(x0, y0, x1, y1) { return [sx(Math.min(x0, x1)), sy(Math.max(y0, y1)), Math.abs(x1 - x0) * cam.s, Math.abs(y1 - y0) * cam.s]; }

  function draw(now) {
    requestAnimationFrame(draw);
    if (!cur || !G) return;
    const n = cur.n, S = cur.snap, P = prev ? prev.snap : S, me = cur.meta, dp = dpr();
    const k = prev ? Math.min(1, (now - curAt) / 33) : 1;
    const X = i => lerp(P[i * UF], S[i * UF], k), Y = i => lerp(P[i * UF + 1], S[i * UF + 1], k);
    if (follow) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
      for (let i = 0; i < n; i++) { const st = S[i * UF + 7]; if (st < 1 || st > 4 || S[i * UF + 24] !== 0) continue; any = true; x0 = Math.min(x0, S[i * UF]); x1 = Math.max(x1, S[i * UF]); y0 = Math.min(y0, S[i * UF + 1]); y1 = Math.max(y1, S[i * UF + 1]); }
      if (!any) { x0 = G[0] - 3000; x1 = G[0] + 3000; y0 = G[1] - 2000; y1 = G[1] + 2000; }
      const pad = 2400, w = Math.max(7000, x1 - x0 + pad * 2), h = Math.max(4200, y1 - y0 + pad * 2);
      cam.tx = (x0 + x1) / 2; cam.ty = (y0 + y1) / 2; cam.ts = Math.min(W / w, H / h);
    }
    const f = RM ? 1 : .07; cam.x += (cam.tx - cam.x) * f; cam.y += (cam.ty - cam.y) * f; cam.s += (cam.ts - cam.s) * f;
    if (me[0] - lastTrailT >= 2 || me[0] < lastTrailT) {
      if (me[0] < lastTrailT) trails.length = 0;
      lastTrailT = me[0];
      for (let i = 0; i < n; i++) { const st = S[i * UF + 7]; trails[i] = trails[i] || []; if (st >= 1 && st <= 4) { trails[i].push([S[i * UF], S[i * UF + 1]]); if (trails[i].length > 60) trails[i].shift(); } }
    }
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (terrDrawn) ctx.drawImage(terr, sx(WORLD.x0), sy(WORLD.y1), (WORLD.x1 - WORLD.x0) * cam.s, (WORLD.y1 - WORLD.y0) * cam.s);
    const step = cam.s > .06 ? 1000 : 5000;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = Math.floor(wx(0) / step) * step; x < wx(W); x += step) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); }
    for (let y = Math.floor(wy(H) / step) * step; y < wy(0); y += step) { ctx.moveTo(0, sy(y)); ctx.lineTo(W, sy(y)); }
    ctx.stroke();
    const jam = (r, name) => { const [x, y, w, h] = r; ctx.fillStyle = 'rgba(255,70,50,.07)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(255,70,50,.8)'; ctx.setLineDash([6 * dp, 5 * dp]); ctx.lineWidth = 1.2 * dp; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); label(name, x + 8 * dp, y + 18 * dp, C.red); };
    if (me[14]) jam(rectW(G[19], G[20], G[21], G[22]), 'GPS DENIED');
    const Z = cur.zones || []; for (let z = 0; z < Z.length; z += 4) jam(rectW(Z[z], Z[z + 1], Z[z + 2], Z[z + 3]), `JAMMING ZONE ${z / 4 + 1}`);
    if (drag && drag.mode === 'zone' && drag.moved) { const x = Math.min(drag.p[0], drag.cur[0]), y = Math.min(drag.p[1], drag.cur[1]); ctx.strokeStyle = C.red; ctx.setLineDash([4 * dp, 4 * dp]); ctx.strokeRect(x, y, Math.abs(drag.cur[0] - drag.p[0]), Math.abs(drag.cur[1] - drag.p[1])); ctx.setLineDash([]); }
    ctx.strokeStyle = '#2c3138'; ctx.lineWidth = 3 * dp;
    for (const ry of [4300, 6400]) { ctx.beginPath(); ctx.moveTo(sx(10200), sy(ry)); ctx.lineTo(sx(13000), sy(ry + 80)); ctx.stroke(); }
    const [ax0, ay1, aw, ah] = rectW(G[14], G[15], G[16], G[17]);
    ctx.save(); ctx.beginPath(); ctx.rect(ax0, ay1, aw, ah); ctx.clip();
    ctx.strokeStyle = 'rgba(196,165,116,.05)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = -ah; i < aw; i += 14 * dp) { ctx.moveTo(ax0 + i, ay1 + ah); ctx.lineTo(ax0 + i + ah, ay1); }
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = 'rgba(196,165,116,.55)'; ctx.setLineDash([2 * dp, 4 * dp]); ctx.lineWidth = dp; ctx.strokeRect(ax0, ay1, aw, ah); ctx.setLineDash([]);
    label('SEARCH AREA · ABSTRACT, SIMULATED', ax0 + 8 * dp, ay1 - 8 * dp, C.tan);
    if (me[20]) { ctx.strokeStyle = 'rgba(196,165,116,.35)'; ctx.beginPath(); ctx.moveTo(ax0, sy(G[18])); ctx.lineTo(ax0 + aw, sy(G[18])); ctx.stroke(); label('A', ax0 + aw + 8 * dp, sy((G[17] + G[18]) / 2), C.fg, 14); label('B', ax0 + aw + 8 * dp, sy((G[15] + G[18]) / 2), C.fg, 14); }
    ctx.strokeStyle = 'rgba(163,168,174,.28)'; ctx.setLineDash([8 * dp, 6 * dp]); ctx.lineWidth = 1.2 * dp; ctx.beginPath();
    [0, 2, 4, 6, 8].forEach((j, i) => i ? ctx.lineTo(sx(G[j]), sy(G[j + 1])) : ctx.moveTo(sx(G[j]), sy(G[j + 1])));
    if (scenario > 2) { ctx.moveTo(sx(G[10]), sy(G[11])); ctx.lineTo(sx(G[12]), sy(G[13])); ctx.lineTo(sx(G[0]), sy(G[1])); } else { ctx.moveTo(sx(G[8]), sy(G[9])); ctx.lineTo(sx(G[12]), sy(G[13])); ctx.lineTo(sx(G[0]), sy(G[1])); }
    ctx.stroke(); ctx.setLineDash([]);
    const WP = [['BASE', 0, true], ['ASSY', 2], ['W1', 4], ['W2', 6], ['W3', 8], ['RDV', 10], ['W4', 12], ['FOB', 25, true], ['HARBOUR', 27, true]];
    for (const [name, j, sq] of WP) {
      if ((name === 'RDV' || name === 'FOB' || name === 'HARBOUR') && scenario <= 2) continue;
      const x = sx(G[j]), y = sy(G[j + 1]), r = 6 * dp, hot = name === 'RDV' && tool === 'rdv';
      ctx.strokeStyle = hot ? C.red : sq ? C.fg : C.steel; ctx.lineWidth = (hot ? 2 : 1.3) * dp; ctx.beginPath();
      if (sq) ctx.rect(x - r, y - r, 2 * r, 2 * r); else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
      ctx.stroke(); label(name, x + 10 * dp, y - 8 * dp, hot ? C.red : C.steel);
    }
    const lb = n * UF + n * n;
    for (let l = 0; l < cur.nl; l++) {
      const o = lb + l * LF, st = S[o + 5], station = S[o + 7];
      const col = st === 3 ? 'rgba(233,229,220,.16)' : st === 2 ? 'rgba(233,229,220,.8)' : st === 1 ? 'rgba(196,165,116,.55)' : 'rgba(163,168,174,.25)';
      if (station) { const x = sx(S[o]), y = sy(S[o + 1]), r = 7 * dp; ctx.strokeStyle = col; ctx.lineWidth = 1.4 * dp; ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke(); ctx.strokeRect(x - r * .6, y - r * .6, r * 1.2, r * 1.2); continue; }
      ctx.strokeStyle = col; ctx.lineWidth = (st === 2 ? 1.6 : 1) * dp; ctx.setLineDash(st >= 2 ? [] : [4 * dp, 5 * dp]);
      ctx.beginPath(); ctx.moveTo(sx(S[o]), sy(S[o + 1])); ctx.lineTo(sx(S[o + 2]), sy(S[o + 3])); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineWidth = dp;
    for (let i = 0; i < n; i++) { const tr = trails[i]; if (!tr || tr.length < 2) continue; ctx.strokeStyle = 'rgba(233,229,220,.09)'; ctx.beginPath(); tr.forEach((p, j) => j ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1]))); ctx.stroke(); }
    ctx.lineWidth = dp; ctx.strokeStyle = eng ? 'rgba(125,155,181,.22)' : 'rgba(196,165,116,.45)'; ctx.beginPath();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (S[n * UF + i * n + j] && (eng || i === selected || j === selected)) { ctx.moveTo(sx(X(i)), sy(Y(i))); ctx.lineTo(sx(X(j)), sy(Y(j))); }
    ctx.stroke();
    for (const g of [0, 1]) {
      const mem = []; let L = -1;
      for (let i = 0; i < n; i++) { const o = i * UF, st = S[o + 7]; if (S[o + 5] !== g || st < 1 || st > 4 || S[o + 24] !== 0) continue; mem.push(i); if (S[o + 6]) L = i; }
      if (!mem.length) continue;
      const form = me[2 + g];
      if (L >= 0 && form <= 3) { ctx.strokeStyle = 'rgba(233,229,220,.1)'; ctx.lineWidth = dp; ctx.beginPath(); for (const i of mem) if (i !== L && S[i * UF + 7] === 1) { ctx.moveTo(sx(X(L)), sy(Y(L))); ctx.lineTo(sx(X(i)), sy(Y(i))); } ctx.stroke(); }
      if (mem.length >= 3) {
        const hp_ = hull(mem.map(i => [sx(X(i)), sy(Y(i))]));
        ctx.strokeStyle = g ? 'rgba(233,229,220,.3)' : 'rgba(196,165,116,.6)'; ctx.setLineDash(g ? [3 * dp, 4 * dp] : [8 * dp, 4 * dp]); ctx.lineWidth = dp; ctx.beginPath();
        hp_.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
        const top = hp_.reduce((a, b) => b[1] < a[1] ? b : a);
        label(`${me[21] || g ? 'GROUP ' + 'AB'[g] : 'SWARM'} · ${FORM[form]} · ${mem.length}`, top[0] - 40 * dp, top[1] - 16 * dp, g ? C.fg : C.tan);
      }
    }
    const z = Math.max(5 * dp, Math.min(11 * dp, cam.s * 150));
    const showIds = eng || cam.s > .07;
    for (let i = 0; i < n; i++) {
      const o = i * UF, st = S[o + 7]; if (st === 0 || st === 6) continue;
      const x = sx(X(i)), y = sy(Y(i)), hd = lerp(P[o + 3], S[o + 3], k), grp = S[o + 5], kind = S[o + 24];
      if (st === 5) { ctx.strokeStyle = 'rgba(255,70,50,.85)'; ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.moveTo(x - 6 * dp, y - 6 * dp); ctx.lineTo(x + 6 * dp, y + 6 * dp); ctx.moveTo(x + 6 * dp, y - 6 * dp); ctx.lineTo(x - 6 * dp, y + 6 * dp); ctx.stroke(); label(`${nameOf(i, S)} LOST`, x + 9 * dp, y - 8 * dp, C.red); continue; }
      if (eng) {
        arrow(x, y, x + S[o + 17] * 25 * cam.s, y - S[o + 18] * 25 * cam.s, 'rgba(233,229,220,.8)');
        const tx = sx(S[o + 13]), ty = sy(S[o + 14]), L = Math.hypot(tx - x, ty - y), c = Math.min(1, 140 * dp / Math.max(L, 1));
        arrow(x, y, x + (tx - x) * c, y + (ty - y) * c, 'rgba(196,165,116,.8)', [5 * dp, 4 * dp]);
        if (S[o + 15] >= 0) { const qx = sx(S[o + 15]), qy = sy(S[o + 16]); ctx.strokeStyle = 'rgba(233,229,220,.55)'; ctx.setLineDash([dp, 3 * dp]); ctx.beginPath(); ctx.moveTo(sx(S[o + 21]), sy(S[o + 22])); ctx.lineTo(qx, qy); ctx.stroke(); ctx.setLineDash([]); ctx.strokeRect(qx - 3 * dp, qy - 3 * dp, 6 * dp, 6 * dp); }
        if (S[o + 19] > 0) label(`L${S[o + 19]}`, x - 18 * dp, y + 16 * dp, C.steel, 10);
      }
      if (S[o + 8] > 12) { ctx.strokeStyle = st === 4 ? 'rgba(255,70,50,.55)' : 'rgba(163,168,174,.4)'; ctx.lineWidth = dp; ctx.beginPath(); ctx.arc(sx(S[o + 21]), sy(S[o + 22]), Math.max(4 * dp, S[o + 8] * cam.s), 0, Math.PI * 2); ctx.stroke(); }
      const fill = st === 4 ? null : st === 2 || st === 3 ? C.steel : kind === 0 ? (grp ? C.bg : C.tan) : kind === 1 ? '#8f7a55' : '#7d9bb5';
      const stroke = st === 4 ? C.red : kind === 0 && grp && st === 1 ? C.fg : kind ? C.fg : null;
      if (kind === 0) plane(x, y, hd, z, fill, stroke); else if (kind === 1) rover(x, y, hd, z * .8, fill || C.bg, stroke); else boat(x, y, hd, z * .9, fill || C.bg, stroke);
      if (S[o + 6]) { ctx.strokeStyle = C.fg; ctx.lineWidth = dp; const r = z + 5 * dp; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.stroke(); }
      if (i === selected || i === hover) { ctx.strokeStyle = C.red; ctx.lineWidth = (i === selected ? 2 : 1.2) * dp; const r = z + 10 * dp, l = 7 * dp; ctx.beginPath();
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(x + a * r, y + b * (r - l)); ctx.lineTo(x + a * r, y + b * r); ctx.lineTo(x + a * (r - l), y + b * r); } ctx.stroke(); }
      if (showIds || i === selected || st !== 1 || S[o + 6] || kind) {
        const tag = `${nameOf(i, S)}${S[o + 6] ? ' L' : ''}${st === 4 ? ' COMMS LOST' : st === 3 ? ' REJOINING' : st === 2 ? ' LEFT' : ''}`;
        label(tag, x + z + 4 * dp, y - z * .6, st === 4 || i === selected ? C.red : C.steel, 10);
      }
    }
    if (hover >= 0 && hover < n && S[hover * UF + 7] !== 6 && S[hover * UF + 7] !== 0) {
      const o = hover * UF, x = sx(X(hover)), y = sy(Y(hover)), lines = [
        `${nameOf(hover, S)} · ${KIND[S[o + 24]]}`, `${STATE[S[o + 7]]} · ${RUNG[S[o + 10]] || ''}`,
        `NAV ${NAV[S[o + 9]] || '?'} ±${Math.round(S[o + 8])} m · ${S[o + 4].toFixed(0)} m/s`, `${S[o + 6] ? 'GROUP LEADER' : S[o + 25] ? 'RELAY RING' : S[o + 20] >= 0 ? 'TASKED' : 'IN FORMATION'} · GROUP ${S[o + 5] ? 'B' : 'A'}`];
      const bw = 250 * dp, bh = 76 * dp, bx = Math.min(W - bw - 8 * dp, x + 18 * dp), by = Math.max(8 * dp, y - bh - 12 * dp);
      ctx.fillStyle = 'rgba(11,13,16,.92)'; ctx.fillRect(bx, by, bw, bh); ctx.strokeStyle = C.redBtn; ctx.lineWidth = dp; ctx.strokeRect(bx, by, bw, bh);
      lines.forEach((t, j) => label(t, bx + 10 * dp, by + (18 + j * 16) * dp, j ? C.steel : C.fg, j ? 10 : 11));
    }
    ctx.fillStyle = 'rgba(11,13,16,.82)'; ctx.fillRect(0, 0, 420 * dp, 60 * dp);
    ctx.fillStyle = C.redBtn; ctx.fillRect(0, 0, 4 * dp, 60 * dp);
    label(`PHASE  ${PHASE[me[1]]}  ·  ${clock(me[0])}`, 16 * dp, 24 * dp, C.fg, 13);
    const zc = (cur.zones || []).length / 4;
    label(`${me[15] ? 'GPS UNAVAILABLE  ' : ''}${me[16] ? 'RADIO DEGRADED  ' : ''}${zc ? `${zc} ZONE(S)  ` : ''}${me[24] > 1 ? `SPACING ×${me[24].toFixed(2)} (LADDER)` : ''}` || `${me[28]} FIXED-WING · ${me[29]} GROUND · ${me[30]} SURFACE`, 16 * dp, 45 * dp, me[15] || me[16] || zc ? C.red : C.tan, 11);
    const bar = 1000 * cam.s; ctx.strokeStyle = C.steel; ctx.lineWidth = dp; ctx.beginPath(); ctx.moveTo(14 * dp, H - 16 * dp); ctx.lineTo(14 * dp + bar, H - 16 * dp); ctx.moveTo(14 * dp, H - 20 * dp); ctx.lineTo(14 * dp, H - 12 * dp); ctx.moveTo(14 * dp + bar, H - 20 * dp); ctx.lineTo(14 * dp + bar, H - 12 * dp); ctx.stroke();
    label('1 KM', 20 * dp + bar, H - 12 * dp, C.steel, 10);
    if (eng) {
      const x0 = W - 300 * dp, y0 = H - 92 * dp; ctx.fillStyle = 'rgba(11,13,16,.85)'; ctx.fillRect(x0 - 10 * dp, y0 - 18 * dp, 300 * dp, 100 * dp);
      arrow(x0, y0, x0 + 34 * dp, y0, C.fg); label('velocity (25 s ahead)', x0 + 44 * dp, y0 + 4 * dp, C.steel, 10);
      arrow(x0, y0 + 20 * dp, x0 + 34 * dp, y0 + 20 * dp, C.tan, [5 * dp, 4 * dp]); label('homing vector to target', x0 + 44 * dp, y0 + 24 * dp, C.steel, 10);
      ctx.strokeStyle = C.fg; ctx.setLineDash([dp, 3 * dp]); ctx.beginPath(); ctx.moveTo(x0, y0 + 40 * dp); ctx.lineTo(x0 + 30 * dp, y0 + 40 * dp); ctx.stroke(); ctx.setLineDash([]); ctx.strokeRect(x0 + 30 * dp, y0 + 37 * dp, 6 * dp, 6 * dp); label('formation vector to slot', x0 + 44 * dp, y0 + 44 * dp, C.steel, 10);
      ctx.strokeStyle = 'rgba(125,155,181,.7)'; ctx.beginPath(); ctx.moveTo(x0, y0 + 60 * dp); ctx.lineTo(x0 + 34 * dp, y0 + 60 * dp); ctx.stroke(); label('comm link   ○ nav uncertainty', x0 + 44 * dp, y0 + 64 * dp, C.steel, 10);
    }
    if (me[1] === 9) label('MISSION COMPLETE', W / 2 - 80 * dp, 30 * dp, C.fg, 14);
  }

  start();
  new IntersectionObserver(es => worker.postMessage({ type: 'visible', on: es.some(e => e.isIntersecting) })).observe(cv);
  requestAnimationFrame(draw);
  window.__live = { frames: () => frames, scenario: () => scenario, phase: () => cur && cur.meta[1], hash: () => cur && cur.hash, n: () => cur && cur.n };
}
