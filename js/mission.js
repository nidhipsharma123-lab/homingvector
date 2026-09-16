// "Fly the mission yourself": renders the swarm mission posted by mission-worker.js, owns the
// scenario selector, transport and failure controls, and the Turtle Eyes console beside the map.
// It never decides anything about the swarm; every state it draws comes from the worker.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const UF = 24, DT = .1;
const PHASE = ['LAUNCH', 'ASSEMBLY', 'FORMATION', 'TRANSIT', 'SPLIT', 'SEARCH', 'RENDEZVOUS', 'REFORM', 'RETURN', 'COMPLETE'];
const FORM = ['WEDGE', 'V', 'LINE', 'COLUMN', 'SEARCH', 'RING'];
const STATE = ['READY', 'ACTIVE', 'LEFT FORMATION', 'REJOINING', 'COMMS LOST', 'LOST', 'LANDED'];
const RUNG = ['NOMINAL', 'DEGRADED NAV', 'DEGRADED COMMS', 'ISOLATED', 'LOST'];
const REGIME = ['CONSENSUS', 'PAIRED', 'SOLO', 'ORPHAN'];
const NAV = ['UNKNOWN', 'GPS', 'VIO', 'TERRAIN', 'PEER RANGING', 'DEAD RECKONING', 'FUSED'];
const SPEED = { 0.5: 15, 1: 30, 2: 60, 4: 120 };
const SKIP = { 1: [1, 2, 4, 6, 7], 2: [4, 5, 6, 7] };
const ABOUT = {
  1: 'One aircraft, alone. With no peers TurtleShield marks it ISOLATED, so it may fly only its pre-loaded plan. GPS drops out on the way.',
  2: 'Eight aircraft: a wedge, a column through the corridor, a V, and one aircraft leaving formation for a sensor check, then rejoining.',
  3: 'Twenty aircraft fly the whole mission with nothing going wrong: launch, assemble, transit, split, search, rendezvous, return.',
  4: 'GPS is denied over the transit corridor. Aircraft fall back to inertial and ranging off their peers, and the formation widens as uncertainty grows.',
  5: 'Radio links degrade in transit and U07 loses its link entirely. It follows the isolation policy, then rejoins when the link returns.',
  6: 'The lead aircraft is lost in transit and two more during the search. Leadership passes on and the survivors take over the lanes.',
  7: 'Everything at once: GPS denial, degraded radio, a comms loss, an aircraft leaving formation, an aircraft lost, and a commanded formation change.',
};
const WORLD = { x0: 0, y0: 0, x1: 27000, y1: 13500 };

export function startLive({ watch, cue, RM }) {
  const cv = $('#map'), ctx = cv.getContext('2d'), hint = $('#tool-hint'), dlog = $('#dlog'), narrate = $('#narrate');
  const q = new URLSearchParams(location.search);
  let scenario = Math.min(7, Math.max(1, parseInt(q.get('scenario'), 10) || 7));
  let seed = Math.max(1, Math.min(999999, parseInt(q.get('seed'), 10) || 11));
  let atOnce = Math.max(0, Math.min(5000, parseFloat(q.get('at')) || 0));
  let W = cv.width, H = cv.height;
  let prev = null, cur = null, curAt = 0, frames = 0, G = null;
  let playing = true, follow = true, eng = q.get('eng') === '1', selected = -1, speedKey = RM ? 0.5 : 1;
  const cam = { x: 9000, y: 6000, s: .05, tx: 9000, ty: 6000, ts: .05 };
  const trails = []; let lastTrailT = -1e9;
  // declared before start() runs, which resets them
  let pendingId = 0, demoTimer = null, rosterBuilt = 0, lastConsole = 0;

  // ---------------- canvas size follows its CSS box
  const fit = () => { const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); W = cv.width = Math.max(320, Math.round(r.width * d)); H = cv.height = Math.max(200, Math.round(r.height * d)); };
  new ResizeObserver(fit).observe(cv); fit();

  // ---------------- terrain, drawn once from a deterministic height field
  const TS = .12, terr = document.createElement('canvas');
  terr.width = Math.round((WORLD.x1 - WORLD.x0) * TS); terr.height = Math.round((WORLD.y1 - WORLD.y0) * TS);
  (() => {
    const t = terr.getContext('2d'); t.fillStyle = '#0a1316'; t.fillRect(0, 0, terr.width, terr.height);
    const hills = [[4000, 9000, 1.4], [7000, 1500, 1], [11500, 3200, .9], [11500, 7300, .9], [15000, 11500, 1.2], [21500, 12800, .8], [3000, 12000, 1.1], [26000, 1500, 1], [9500, 11000, .7], [17500, 2200, .9]];
    t.lineWidth = 1;
    for (const [hx, hy, k] of hills) for (let ring = 1; ring < 9; ring++) {
      t.strokeStyle = ring % 4 === 0 ? '#1b2c2b' : '#12201f'; t.beginPath();
      for (let a = 0; a <= 72; a++) {
        const th = a / 72 * Math.PI * 2, r = ring * 170 * k * (1 + .18 * Math.sin(3 * th + hx) + .08 * Math.cos(5 * th + hy));
        const px = (hx + Math.cos(th) * r) * TS, py = (WORLD.y1 - (hy + Math.sin(th) * r)) * TS;
        a ? t.lineTo(px, py) : t.moveTo(px, py);
      }
      t.stroke();
    }
  })();

  const sx = x => (x - cam.x) * cam.s + W / 2, sy = y => H / 2 - (y - cam.y) * cam.s;
  const wx = px => (px - W / 2) / cam.s + cam.x, wy = py => cam.y - (py - H / 2) / cam.s;

  // ---------------- worker
  const worker = new Worker(new URL('./mission-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'frame') { if (m.geom) G = m.geom; prev = cur; cur = m; curAt = performance.now(); frames++; if (m.log) ingest(m.log); consoleUpdate(); }
    else if (m.type === 'ready') { hint.textContent = ABOUT[scenario]; }
    else if (m.type === 'error') hint.textContent = `Simulation error: ${m.message}`;
  };
  const start = () => { prev = cur = null; trails.length = 0; lastTrailT = -1e9; dlog.textContent = ''; selected = -1; rosterBuilt = 0; pendingId = 0; clearTimeout(demoTimer); demoTimer = null; worker.postMessage({ type: 'init', scenario, seed, at: atOnce }); if (atOnce) setTimeout(() => addLine(`Fast-forwarded to T+${Math.floor(atOnce / 60)}:${String(Math.floor(atOnce % 60)).padStart(2, '0')}; decisions on the way were confirmed by the demo operator`, 'op'), 400); atOnce = 0; phaseRibbon(); };
  worker.postMessage({ type: 'speed', v: SPEED[speedKey] });
  start();
  // Its own observer, not the shared scroll watcher: this module loads lazily, and a scroll-driven check
  // registered after the last scroll never fires -- a visitor arriving at #live without scrolling again
  // got a frozen map (found by missionkeys.mjs: 1 frame in 30 s).
  new IntersectionObserver(es => worker.postMessage({ type: 'visible', on: es.some(e => e.isIntersecting) })).observe(cv);

  // ---------------- scenario selector (radio group, arrow keys move)
  const scen = $$('.scen [role="radio"]');
  const pickScen = (b, focus) => {
    scen.forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; });
    if (focus) b.focus();
    scenario = +b.dataset.scen; start();
  };
  scen.forEach(b => { b.tabIndex = +b.dataset.scen === scenario ? 0 : -1; b.setAttribute('aria-checked', String(+b.dataset.scen === scenario)); });
  scen.forEach((b, i) => {
    b.addEventListener('click', () => pickScen(b, false));
    b.addEventListener('keydown', e => {
      const k = e.key; let j = -1;
      if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % scen.length; else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + scen.length) % scen.length;
      else if (k === 'Home') j = 0; else if (k === 'End') j = scen.length - 1;
      if (j >= 0) { e.preventDefault(); pickScen(scen[j], true); }
    });
  });

  // ---------------- transport
  const btn = s => $(`.transport [data-act="${s}"]`);
  btn('play').addEventListener('click', () => { playing = !playing; worker.postMessage({ type: 'play', on: playing }); btn('play').setAttribute('aria-pressed', String(playing)); btn('play').textContent = playing ? 'Pause' : 'Play'; });
  btn('step').addEventListener('click', () => { if (playing) btn('play').click(); worker.postMessage({ type: 'step', sec: 1 }); });
  btn('restart').addEventListener('click', () => { start(); hint.textContent = `Restarted: ${ABOUT[scenario]}`; });
  btn('follow').addEventListener('click', () => { follow = !follow; btn('follow').setAttribute('aria-pressed', String(follow)); });
  btn('eng').setAttribute('aria-pressed', String(eng));
  btn('eng').addEventListener('click', () => { eng = !eng; btn('eng').setAttribute('aria-pressed', String(eng)); hint.textContent = eng ? 'Engineering view: velocity (solid), homing (dashed), formation slot (dotted to square), navigation uncertainty (circle), links weighted, separation layer tags.' : ABOUT[scenario]; });
  const speeds = $$('.speed [role="radio"]');
  speeds.forEach((b, i) => {
    b.tabIndex = +b.dataset.speed === speedKey ? 0 : -1; b.setAttribute('aria-checked', String(+b.dataset.speed === speedKey));
    const set = focus => { speedKey = +b.dataset.speed; speeds.forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; }); if (focus) b.focus(); worker.postMessage({ type: 'speed', v: SPEED[speedKey] }); };
    b.addEventListener('click', () => set(false));
    b.addEventListener('keydown', e => { let j = -1; if (e.key === 'ArrowRight') j = (i + 1) % speeds.length; else if (e.key === 'ArrowLeft') j = (i - 1 + speeds.length) % speeds.length; if (j >= 0) { e.preventDefault(); speeds[j].click(); speeds[j].focus(); } });
  });

  // ---------------- failures
  const E = { GPS_ON: 1, GPS_OFF: 2, RADIO_ON: 3, RADIO_OFF: 4, CUT: 5, LOSE: 6, LEAVE: 7, FORM: 8 };
  const need = what => { if (selected < 0) { hint.textContent = `Select an aircraft first (click it on the map or in the Fleet list), then ${what}.`; return false; } return true; };
  $$('.inject [data-ev]').forEach(b => b.addEventListener('click', () => {
    const me = cur && cur.meta; if (!me) return;
    switch (b.dataset.ev) {
      case 'gps': worker.postMessage({ type: 'event', kind: me[15] ? E.GPS_OFF : E.GPS_ON, arg: 0 }); break;
      case 'radio': worker.postMessage({ type: 'event', kind: me[16] ? E.RADIO_OFF : E.RADIO_ON, arg: 0 }); break;
      case 'cut': if (need('cut its comms')) worker.postMessage({ type: 'event', kind: E.CUT, arg: selected }); break;
      case 'leave': if (need('send it out of formation')) worker.postMessage({ type: 'event', kind: E.LEAVE, arg: selected }); break;
      case 'lose': if (need('remove it')) worker.postMessage({ type: 'event', kind: E.LOSE, arg: selected }); break;
      case 'form': worker.postMessage({ type: 'event', kind: E.FORM, arg: Math.max(selected, 0) }); break;
    }
  }));

  // ---------------- selection on the map, pan, zoom (never on the scroll wheel: no scroll-jacking)
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { p: pos(e), cx: cam.x, cy: cam.y, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (!drag) return; const [px, py] = pos(e); const dx = px - drag.p[0], dy = py - drag.p[1]; if (Math.hypot(dx, dy) > 6) { drag.moved = true; if (follow) btn('follow').click(); } if (drag.moved) { cam.x = cam.tx = drag.cx - dx / cam.s; cam.y = cam.ty = drag.cy + dy / cam.s; } });
  cv.addEventListener('pointerup', e => {
    if (drag && !drag.moved && cur) {
      const [px, py] = pos(e); let best = -1, bd = 30 * (W / cv.getBoundingClientRect().width);
      for (let i = 0; i < cur.n; i++) { const o = i * UF, st = cur.snap[o + 7]; if (st === 0 || st === 6) continue; const d = Math.hypot(sx(cur.snap[o]) - px, sy(cur.snap[o + 1]) - py); if (d < bd) { bd = d; best = i; } }
      select(best === selected ? -1 : best);
    }
    drag = null;
  });
  cv.addEventListener('dblclick', e => { const [px, py] = pos(e); const k = e.shiftKey ? .6 : 1.6; cam.tx = wx(px); cam.ty = wy(py); cam.ts = Math.max(.012, Math.min(.5, cam.s * k)); if (follow) btn('follow').click(); });
  cv.addEventListener('keydown', e => {
    if (!cur) return; const alive = [...Array(cur.n).keys()].filter(i => { const st = cur.snap[i * UF + 7]; return st > 0 && st < 5; });
    let used = true;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') select(alive[(alive.indexOf(selected) + 1) % alive.length] ?? -1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') select(alive[(alive.indexOf(selected) - 1 + alive.length) % alive.length] ?? -1);
    else if (e.key === '+' || e.key === '=') { cam.ts = Math.min(.5, cam.ts * 1.4); if (follow) btn('follow').click(); }
    else if (e.key === '-') { cam.ts = Math.max(.012, cam.ts / 1.4); if (follow) btn('follow').click(); }
    else if (e.key === 'Escape') select(-1);
    else used = false;
    if (used) e.preventDefault();
  });
  function select(i) {
    selected = i;
    $$('#roster button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.u === i)));
    if (i >= 0) hint.textContent = `U${String(i + 1).padStart(2, '0')} selected. Its telemetry is in the Turtle Eyes console; failures marked "selected" act on it.`;
    consoleUpdate(true);
  }

  // ---------------- decision: hold to confirm, or the clearly labelled demo operator
  const hold = $('#hold'), holdHint = $('#hold-hint'), rec = $('#rec'), recText = $('#rec-text'), demoOp = $('#demo-op');
  let holding = false, hp = 0, ht0 = 0, armed = 0, lastGesture = 0;
  const confirmNow = (who) => {
    if (!pendingId) return;
    worker.postMessage({ type: 'confirm', id: pendingId });
    addLine(`OPERATOR  ${who}`, 'op'); clearTimeout(demoTimer); demoTimer = null;
    hold.disabled = true; releaseVisual(); holdHint.textContent = who.startsWith('DEMO') ? 'Confirmed by the demo operator.' : 'Confirmed.';
  };
  function holdFrame() {
    if (!holding) return;
    hp = Math.max(0, Math.min(1, (performance.now() - ht0) / 1100)); hold.style.setProperty('--p', hp);
    if (hp >= 1) { holding = false; confirmNow('confirmed by you (held)'); return; }
    requestAnimationFrame(holdFrame);
  }
  const releaseVisual = () => { hold.classList.add('rel'); hold.style.setProperty('--p', 0); hp = 0; };
  const startHold = e => { if (hold.disabled || holding) return; if (e && e.preventDefault) e.preventDefault(); lastGesture = performance.now();
    if (demoOp.checked) { demoOp.checked = false; clearTimeout(demoTimer); demoTimer = null; }
    holding = true; hold.classList.remove('rel'); ht0 = performance.now(); holdHint.textContent = 'Keep holding…'; requestAnimationFrame(holdFrame); };
  const endHold = () => { if (!holding) return; holding = false; releaseVisual(); if (!hold.disabled) holdHint.textContent = 'Let go too early. Hold for about a second.'; };
  hold.addEventListener('pointerdown', startHold);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => hold.addEventListener(ev, endHold));
  hold.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) startHold(e); });
  hold.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') endHold(); });
  hold.addEventListener('contextmenu', e => e.preventDefault());
  // a hold must never complete itself: losing focus or the tab ends it (no keyup ever arrives)
  hold.addEventListener('blur', endHold); addEventListener('blur', endHold);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endHold(); });
  // screen readers activate with a synthetic click: keep the deliberateness with two activations
  hold.addEventListener('click', e => {
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
  const set = (id, v, cls) => { const el = $(id); if (el.textContent !== String(v)) el.textContent = v; if (cls !== undefined) el.className = cls; };
  function consoleUpdate(force) {
    if (!cur) return;
    const now = performance.now(); if (!force && now - lastConsole < 180) return; lastConsole = now;
    const me = cur.meta, n = cur.n, S = cur.snap;
    const t = Math.floor(me[0]); set('#sim-clock', `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    set('#s-n', n); set('#s-act', me[8]); set('#s-rej', me[9] + me[13], me[9] + me[13] ? 'warn' : '');
    set('#s-cl', me[10], me[10] ? 'bad' : ''); set('#s-lost', me[11], me[11] ? 'bad' : ''); set('#s-land', me[12]);
    const ph = me[1];
    const CH = { 3: [2, 3, 4], 5: [5], 6: [6, 7], 8: [8, 9] };
    $$('#chain span').forEach(s => { const set_ = CH[+s.dataset.p]; s.className = set_.includes(ph) ? 'on' : ph > Math.max(...set_) ? 'done' : ''; });
    const lead = i => i >= 0 ? `LEADER U${String(i + 1).padStart(2, '0')}` : 'NO LEADER';
    set('#ga-n', `${me[4]} UAVs`); set('#ga-f', FORM[me[2]] || '–'); set('#ga-l', lead(me[6]));
    set('#gb-n', me[21] ? `${me[5]} UAVs` : 'not split'); set('#gb-f', me[21] ? (FORM[me[3]] || '–') : '–'); set('#gb-l', me[21] ? lead(me[7]) : '–');
    $$('.grp')[1].classList.toggle('off', !me[21]);
    // decision
    const pid = me[17];
    if (pid !== pendingId) {
      pendingId = pid; armed = 0;
      if (pid) { rec.classList.add('live-dec'); recText.textContent = cur.decision; hold.disabled = false; holdHint.textContent = ''; armDemo(); cue('tick'); narrate.textContent = `Awaiting operator: ${cur.decision}`; }
      else { rec.classList.remove('live-dec'); recText.textContent = ph === 9 ? 'Mission complete. Nothing pending.' : 'No decision pending. The swarm is executing the plan.'; hold.disabled = true; }
    }
    // failure toggles reflect the sim, not our last click
    $('.inject [data-ev="gps"]').setAttribute('aria-pressed', String(!!me[15]));
    $('.inject [data-ev="radio"]').setAttribute('aria-pressed', String(!!me[16]));
    // roster
    if (rosterBuilt !== n) {
      const r = $('#roster'); r.textContent = '';
      for (let i = 0; i < n; i++) { const b = document.createElement('button'); b.type = 'button'; b.dataset.u = i; b.textContent = `U${String(i + 1).padStart(2, '0')}`; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => select(+b.dataset.u === selected ? -1 : i)); r.appendChild(b); }
      rosterBuilt = n;
    }
    $$('#roster button').forEach((b, i) => {
      const o = i * UF, st = S[o + 7];
      const c = st === 3 || st === 2 ? 'rej' : st === 4 ? 'cl' : st === 5 ? 'lost' : st === 6 ? 'land' : S[o + 5] === 1 ? 'b' : '';
      if (b.className !== c) b.className = c;
      const label = `U${String(i + 1).padStart(2, '0')}, ${STATE[st].toLowerCase()}${S[o + 6] ? ', group leader' : ''}`;
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    });
    // telemetry
    const tele = $('#tele');
    if (selected < 0 || selected >= n) { if (tele.dataset.u !== '-1') { tele.dataset.u = '-1'; tele.innerHTML = '<div><dt>Selected</dt><dd>none</dd></div>'; } }
    else {
      const o = selected * UF, st = S[o + 7];
      const rows = [
        ['ID', `U${String(selected + 1).padStart(2, '0')}`], ['Group', S[o + 5] ? 'B' : 'A'], ['Role', S[o + 6] ? 'LEADER' : 'FOLLOWER'],
        ['State', STATE[st], st >= 4 ? 'bad' : ''], ['Speed', `${S[o + 4].toFixed(1)} m/s`], ['Heading', `${String(Math.round(((90 - S[o + 3] * 57.2958) % 360 + 360) % 360)).padStart(3, '0')}°`],
        ['Altitude', `${Math.round(S[o + 2])} m`], ['Sep. layer', S[o + 19] ? `L${S[o + 19]} +${S[o + 19] * 40} m` : 'base'],
        ['Nav', NAV[S[o + 9]] || '?', S[o + 9] === 5 ? 'bad' : ''], ['Nav 1σ', `${Math.round(S[o + 8])} m`],
        ['Ladder', RUNG[S[o + 10]] || '?', S[o + 10] >= 3 ? 'bad' : ''], ['Quorum', REGIME[S[o + 11]] || '?'],
        ['Link', `${Math.round(S[o + 12] * 100)}% peers`, S[o + 12] < .5 ? 'bad' : ''], ['Slot err', S[o + 15] >= 0 ? `${Math.round(Math.hypot(S[o + 15] - S[o], S[o + 16] - S[o + 1]))} m` : '–'],
        ['Lane', S[o + 20] >= 0 ? `${S[o + 20] + 1}` : '–'], ['Formation', FORM[S[o + 5] ? me[3] : me[2]] || '–'],
      ];
      tele.dataset.u = selected;
      tele.innerHTML = rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd></div>`).join('');
    }
    phaseRibbon(ph);
  }
  function phaseRibbon(ph = cur ? cur.meta[1] : 0) {
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
    const t = cur ? Math.floor(cur.meta[0]) : 0;
    b.textContent = `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; li.append(b, text);
    if (cls) li.className = cls; dlog.prepend(li);
  }
  function ingest(text) {
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n').filter(Boolean)) {
      if (/launched$|lane complete$|landed$/.test(line) && !/UAVs/.test(line)) continue;       // routine; the counters carry it
      const li = document.createElement('li'), b = document.createElement('b');
      b.textContent = line.slice(0, 7); li.append(b, line.slice(8));
      const body = line.slice(8);
      if (/^EVENT|COMMS LOST|declared DEAD|lost$/.test(body)) li.className = 'adv';
      else if (/OPERATOR/.test(body)) li.className = 'op';
      else if (/took lane|back in slot|link restored|MISSION COMPLETE|GPS restored|GPS available|RENDEZVOUS/.test(body)) li.className = 'good';
      frag.prepend(li);
      if (/^EVENT .*lost|declared DEAD/.test(body)) { glitch(); cue('impact'); sayQueue = body; }
      else if (/^EVENT|COMMS LOST/.test(body)) { glitch(); cue('tick'); sayQueue = body; }
      else if (/^PHASE|took lane|link restored|MISSION COMPLETE|leader U/.test(body)) { cue('good'); sayQueue = body; }
    }
    dlog.prepend(frag);
    while (dlog.children.length > 200) dlog.lastChild.remove();
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
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.4; ctx.stroke(); }
    ctx.restore();
  }
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
  const d = () => Math.min(devicePixelRatio || 1, 2);
  function label(txt, x, y, col, size = 11) { ctx.font = `${size * d()}px "IBM Plex Mono", monospace`; ctx.fillStyle = col; ctx.fillText(txt, x, y); }

  function draw(now) {
    requestAnimationFrame(draw);
    if (!cur || !G) return;
    const k = prev && prev.n === cur.n ? Math.min(1, (now - curAt) / 33) : 1;
    const S = cur.snap, P = prev && prev.n === cur.n ? prev.snap : S, n = cur.n, me = cur.meta, dp = d();
    const X = i => lerp(P[i * UF], S[i * UF], k), Y = i => lerp(P[i * UF + 1], S[i * UF + 1], k);
    // camera: follow the flying swarm, smoothly
    if (follow) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
      for (let i = 0; i < n; i++) { const st = S[i * UF + 7]; if (st < 1 || st > 4) continue; any = true; x0 = Math.min(x0, S[i * UF]); x1 = Math.max(x1, S[i * UF]); y0 = Math.min(y0, S[i * UF + 1]); y1 = Math.max(y1, S[i * UF + 1]); }
      if (!any) { x0 = G[0] - 3000; x1 = G[0] + 3000; y0 = G[1] - 2000; y1 = G[1] + 2000; }
      const pad = 2200, w = Math.max(6000, x1 - x0 + pad * 2), h = Math.max(3600, y1 - y0 + pad * 2);
      cam.tx = (x0 + x1) / 2; cam.ty = (y0 + y1) / 2; cam.ts = Math.min(W / w, H / h);
    }
    const f = RM ? 1 : .06; cam.x += (cam.tx - cam.x) * f; cam.y += (cam.ty - cam.y) * f; cam.s += (cam.ts - cam.s) * f;
    // trails, sampled every 1.5 simulated seconds
    if (me[0] - lastTrailT >= 1.5 || me[0] < lastTrailT) {
      if (me[0] < lastTrailT) trails.length = 0;
      lastTrailT = me[0];
      for (let i = 0; i < n; i++) { const st = S[i * UF + 7]; trails[i] = trails[i] || []; if (st >= 1 && st <= 4) { trails[i].push([S[i * UF], S[i * UF + 1]]); if (trails[i].length > 90) trails[i].shift(); } }
    }
    // ground
    ctx.fillStyle = '#081012'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(terr, sx(WORLD.x0), sy(WORLD.y1), (WORLD.x1 - WORLD.x0) * cam.s, (WORLD.y1 - WORLD.y0) * cam.s);
    const step = cam.s > .06 ? 1000 : 5000;
    ctx.strokeStyle = 'rgba(236,231,218,.035)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = Math.floor(wx(0) / step) * step; x < wx(W); x += step) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); }
    for (let y = Math.floor(wy(H) / step) * step; y < wy(0); y += step) { ctx.moveTo(0, sy(y)); ctx.lineTo(W, sy(y)); }
    ctx.stroke();
    // GPS denial
    if (me[14]) { ctx.fillStyle = 'rgba(255,74,43,.06)'; ctx.fillRect(sx(G[19]), sy(G[22]), (G[21] - G[19]) * cam.s, (G[22] - G[20]) * cam.s); ctx.strokeStyle = 'rgba(255,74,43,.7)'; ctx.setLineDash([6 * dp, 5 * dp]); ctx.strokeRect(sx(G[19]), sy(G[22]), (G[21] - G[19]) * cam.s, (G[22] - G[20]) * cam.s); ctx.setLineDash([]); label('GPS DENIED', sx(G[19]) + 8 * dp, sy(G[22]) + 18 * dp, '#ff4a2b'); }
    // corridor ridges
    ctx.strokeStyle = '#2c2e28'; ctx.lineWidth = 3 * dp;
    for (const ry of [4300, 6400]) { ctx.beginPath(); ctx.moveTo(sx(10200), sy(ry)); ctx.lineTo(sx(13000), sy(ry + 80)); ctx.stroke(); }
    // search area: abstract, simulated
    const ax0 = sx(G[14]), ay1 = sy(G[17]), aw = (G[16] - G[14]) * cam.s, ah = (G[17] - G[15]) * cam.s;
    ctx.save(); ctx.beginPath(); ctx.rect(ax0, ay1, aw, ah); ctx.clip();
    ctx.strokeStyle = 'rgba(236,231,218,.045)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = -ah; i < aw; i += 14 * dp) { ctx.moveTo(ax0 + i, ay1 + ah); ctx.lineTo(ax0 + i + ah, ay1); }
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = 'rgba(236,231,218,.4)'; ctx.setLineDash([2 * dp, 4 * dp]); ctx.strokeRect(ax0, ay1, aw, ah); ctx.setLineDash([]);
    label('SEARCH AREA · ABSTRACT, SIMULATED', ax0 + 8 * dp, ay1 - 8 * dp, '#a9b5b0');
    if (me[20]) { ctx.strokeStyle = 'rgba(236,231,218,.25)'; ctx.beginPath(); ctx.moveTo(ax0, sy(G[18])); ctx.lineTo(ax0 + aw, sy(G[18])); ctx.stroke(); label('A', ax0 + aw + 8 * dp, sy((G[17] + G[18]) / 2), '#ece7da', 14); label('B', ax0 + aw + 8 * dp, sy((G[15] + G[18]) / 2), '#ece7da', 14); }
    // route and waypoints
    const WP = [['BASE', 0], ['ASSY', 2], ['W1', 4], ['W2', 6], ['W3', 8], ['RDV', 10], ['W4', 12]];
    ctx.strokeStyle = 'rgba(169,181,176,.28)'; ctx.setLineDash([8 * dp, 6 * dp]); ctx.lineWidth = 1.2 * dp; ctx.beginPath();
    [0, 2, 4, 6, 8].forEach((j, i) => i ? ctx.lineTo(sx(G[j]), sy(G[j + 1])) : ctx.moveTo(sx(G[j]), sy(G[j + 1])));
    if (scenario > 2) { ctx.moveTo(sx(G[10]), sy(G[11])); ctx.lineTo(sx(G[12]), sy(G[13])); ctx.lineTo(sx(G[0]), sy(G[1])); } else { ctx.moveTo(sx(G[8]), sy(G[9])); ctx.lineTo(sx(G[12]), sy(G[13])); ctx.lineTo(sx(G[0]), sy(G[1])); }
    ctx.stroke(); ctx.setLineDash([]);
    for (const [name, j] of WP) {
      if (name === 'RDV' && scenario <= 2) continue;
      const x = sx(G[j]), y = sy(G[j + 1]), r = 6 * dp;
      ctx.strokeStyle = name === 'BASE' ? '#ece7da' : '#a9b5b0'; ctx.lineWidth = 1.3 * dp; ctx.beginPath();
      if (name === 'BASE') ctx.rect(x - r, y - r, 2 * r, 2 * r); else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
      ctx.stroke(); label(name, x + 10 * dp, y - 8 * dp, '#a9b5b0');
    }
    // lanes
    const lb = n * UF + n * n;
    for (let l = 0; l < cur.nl; l++) {
      const o = lb + l * 7, st = S[o + 5];
      ctx.strokeStyle = st === 3 ? 'rgba(236,231,218,.16)' : st === 2 ? 'rgba(236,231,218,.75)' : st === 1 ? 'rgba(236,231,218,.4)' : 'rgba(169,181,176,.22)';
      ctx.lineWidth = (st === 2 ? 1.6 : 1) * dp; ctx.setLineDash(st === 3 || st === 2 ? [] : [4 * dp, 5 * dp]);
      ctx.beginPath(); ctx.moveTo(sx(S[o]), sy(S[o + 1])); ctx.lineTo(sx(S[o + 2]), sy(S[o + 3])); ctx.stroke();
    }
    ctx.setLineDash([]);
    // trails
    for (let i = 0; i < n; i++) {
      const tr = trails[i]; if (!tr || tr.length < 2) continue;
      for (let j = 1; j < tr.length; j++) { ctx.strokeStyle = `rgba(236,231,218,${(.18 * j / tr.length).toFixed(3)})`; ctx.lineWidth = dp; ctx.beginPath(); ctx.moveTo(sx(tr[j - 1][0]), sy(tr[j - 1][1])); ctx.lineTo(sx(tr[j][0]), sy(tr[j][1])); ctx.stroke(); }
    }
    // comm links
    ctx.lineWidth = dp; ctx.strokeStyle = eng ? 'rgba(95,208,196,.3)' : 'rgba(95,208,196,.1)'; ctx.beginPath();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (S[n * UF + i * n + j]) { ctx.moveTo(sx(X(i)), sy(Y(i))); ctx.lineTo(sx(X(j)), sy(Y(j))); }
    ctx.stroke();
    // groups: hull, leader->follower lines, label
    for (const g of [0, 1]) {
      const mem = []; let L = -1;
      for (let i = 0; i < n; i++) { const o = i * UF, st = S[o + 7]; if (S[o + 5] !== g || st < 1 || st > 4) continue; mem.push(i); if (S[o + 6]) L = i; }
      if (!mem.length) continue;
      const form = me[2 + g];
      if (L >= 0 && form <= 3) {
        ctx.strokeStyle = 'rgba(236,231,218,.14)'; ctx.lineWidth = dp; ctx.beginPath();
        for (const i of mem) if (i !== L && S[i * UF + 7] === 1) { ctx.moveTo(sx(X(L)), sy(Y(L))); ctx.lineTo(sx(X(i)), sy(Y(i))); }
        ctx.stroke();
      }
      if (mem.length >= 3) {
        const hp_ = hull(mem.map(i => [sx(X(i)), sy(Y(i))]));
        ctx.strokeStyle = g ? 'rgba(236,231,218,.3)' : 'rgba(236,231,218,.45)'; ctx.setLineDash(g ? [3 * dp, 4 * dp] : [8 * dp, 4 * dp]); ctx.lineWidth = dp; ctx.beginPath();
        hp_.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
        const top = hp_.reduce((a, b) => b[1] < a[1] ? b : a);
        label(`${me[21] || g ? 'GROUP ' + 'AB'[g] : 'SWARM'} · ${FORM[form]} · ${mem.length}`, top[0] - 40 * dp, top[1] - 16 * dp, '#ece7da');
      }
    }
    // aircraft
    const z = Math.max(6 * dp, Math.min(11 * dp, cam.s * 150));
    const showIds = eng || cam.s > .05;
    for (let i = 0; i < n; i++) {
      const o = i * UF, st = S[o + 7]; if (st === 0 || st === 6) continue;
      const x = sx(X(i)), y = sy(Y(i)), hd = lerp(P[o + 3], S[o + 3], k), grp = S[o + 5];
      if (st === 5) { ctx.strokeStyle = 'rgba(255,74,43,.8)'; ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.moveTo(x - 6 * dp, y - 6 * dp); ctx.lineTo(x + 6 * dp, y + 6 * dp); ctx.moveTo(x + 6 * dp, y - 6 * dp); ctx.lineTo(x - 6 * dp, y + 6 * dp); ctx.stroke(); label(`U${String(i + 1).padStart(2, '0')} LOST`, x + 9 * dp, y - 8 * dp, '#ff4a2b'); continue; }
      if (eng) {
        const vx = S[o + 17], vy = S[o + 18];
        arrow(x, y, x + vx * 25 * cam.s, y - vy * 25 * cam.s, 'rgba(236,231,218,.85)');
        const tx = sx(S[o + 13]), ty = sy(S[o + 14]), L = Math.hypot(tx - x, ty - y), c = Math.min(1, 140 * dp / Math.max(L, 1));
        arrow(x, y, x + (tx - x) * c, y + (ty - y) * c, 'rgba(169,181,176,.8)', [5 * dp, 4 * dp]);
        if (S[o + 15] >= 0) { const qx = sx(S[o + 15]), qy = sy(S[o + 16]); ctx.strokeStyle = 'rgba(236,231,218,.6)'; ctx.setLineDash([dp, 3 * dp]); ctx.beginPath(); ctx.moveTo(sx(S[o + 21]), sy(S[o + 22])); ctx.lineTo(qx, qy); ctx.stroke(); ctx.setLineDash([]); ctx.strokeRect(qx - 3 * dp, qy - 3 * dp, 6 * dp, 6 * dp); }
        if (S[o + 19] > 0) label(`L${S[o + 19]}`, x - 18 * dp, y + 16 * dp, '#a9b5b0', 10);
      }
      if (S[o + 8] > 12) { ctx.strokeStyle = st === 4 ? 'rgba(255,74,43,.55)' : 'rgba(169,181,176,.45)'; ctx.lineWidth = dp; ctx.beginPath(); ctx.arc(sx(S[o + 21]), sy(S[o + 22]), Math.max(4 * dp, S[o + 8] * cam.s), 0, Math.PI * 2); ctx.stroke(); }
      const col = st === 4 ? null : st === 2 || st === 3 ? '#a9b5b0' : grp ? '#0b1417' : '#c6f032';
      const stroke = st === 4 ? '#ff4a2b' : grp && st === 1 ? '#ece7da' : null;
      plane(x, y, hd, z, col, stroke);
      if (S[o + 6]) { ctx.strokeStyle = '#ece7da'; ctx.lineWidth = dp; const r = z + 5 * dp; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.stroke(); }
      if (i === selected) { ctx.strokeStyle = '#c6f032'; ctx.lineWidth = 2 * dp; const r = z + 10 * dp, l = 7 * dp; ctx.beginPath();
        for (const [sx_, sy_] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(x + sx_ * r, y + sy_ * (r - l)); ctx.lineTo(x + sx_ * r, y + sy_ * r); ctx.lineTo(x + sx_ * (r - l), y + sy_ * r); } ctx.stroke(); }
      if (showIds || i === selected || st !== 1 || S[o + 6]) {
        const tag = `U${String(i + 1).padStart(2, '0')}${S[o + 6] ? ' L' : ''}${st === 4 ? ' COMMS LOST' : st === 3 ? ' REJOINING' : st === 2 ? ' LEFT' : ''}`;
        label(tag, x + z + 4 * dp, y - z * .6, st === 4 ? '#ff4a2b' : i === selected ? '#c6f032' : '#a9b5b0', 10.5);
      }
    }
    // HUD, drawn into the same image (never a DOM layer over the map)
    ctx.fillStyle = 'rgba(8,16,18,.8)'; ctx.fillRect(0, 0, 380 * dp, 58 * dp);
    label(`PHASE  ${PHASE[me[1]]}`, 14 * dp, 24 * dp, '#c6f032', 13);
    label(`${me[15] ? 'GPS UNAVAILABLE  ' : ''}${me[16] ? 'RADIO DEGRADED  ' : ''}${me[24] > 1 ? `SPACING ×${me[24].toFixed(2)} (LADDER)` : ''}` || 'ALL LINKS NOMINAL', 14 * dp, 44 * dp, me[15] || me[16] ? '#ff4a2b' : '#a9b5b0', 11);
    const bar = 1000 * cam.s; ctx.strokeStyle = '#a9b5b0'; ctx.lineWidth = dp; ctx.beginPath(); ctx.moveTo(14 * dp, H - 16 * dp); ctx.lineTo(14 * dp + bar, H - 16 * dp); ctx.moveTo(14 * dp, H - 20 * dp); ctx.lineTo(14 * dp, H - 12 * dp); ctx.moveTo(14 * dp + bar, H - 20 * dp); ctx.lineTo(14 * dp + bar, H - 12 * dp); ctx.stroke();
    label('1 KM', 20 * dp + bar, H - 12 * dp, '#a9b5b0', 10);
    if (eng) {
      const x0 = W - 300 * dp, y0 = H - 92 * dp; ctx.fillStyle = 'rgba(8,16,18,.85)'; ctx.fillRect(x0 - 10 * dp, y0 - 18 * dp, 300 * dp, 100 * dp);
      arrow(x0, y0, x0 + 34 * dp, y0, '#ece7da'); label('velocity (25 s ahead)', x0 + 44 * dp, y0 + 4 * dp, '#a9b5b0', 10);
      arrow(x0, y0 + 20 * dp, x0 + 34 * dp, y0 + 20 * dp, '#a9b5b0', [5 * dp, 4 * dp]); label('homing vector to target', x0 + 44 * dp, y0 + 24 * dp, '#a9b5b0', 10);
      ctx.strokeStyle = '#ece7da'; ctx.setLineDash([dp, 3 * dp]); ctx.beginPath(); ctx.moveTo(x0, y0 + 40 * dp); ctx.lineTo(x0 + 30 * dp, y0 + 40 * dp); ctx.stroke(); ctx.setLineDash([]); ctx.strokeRect(x0 + 30 * dp, y0 + 37 * dp, 6 * dp, 6 * dp); label('formation vector to slot', x0 + 44 * dp, y0 + 44 * dp, '#a9b5b0', 10);
      ctx.strokeStyle = 'rgba(95,208,196,.7)'; ctx.beginPath(); ctx.moveTo(x0, y0 + 60 * dp); ctx.lineTo(x0 + 34 * dp, y0 + 60 * dp); ctx.stroke(); label('comm link   ○ nav uncertainty', x0 + 44 * dp, y0 + 64 * dp, '#a9b5b0', 10);
    }
    if (me[1] === 9) { label('MISSION COMPLETE', W / 2 - 80 * dp, 30 * dp, '#ece7da', 14); }
  }
  requestAnimationFrame(draw);
  window.__live = { frames: () => frames, scenario: () => scenario, phase: () => cur && cur.meta[1], hash: () => cur && cur.hash };
}
