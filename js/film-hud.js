// Tracking brackets on the hero film, COMPOSITED: the canvas paints each video frame and draws the
// brackets into the same image, and the <video> element is made invisible. One image, nothing layered
// on top of another -- the page's no-overlap rule is absolute and a transparent overlay would break it.
// No text is drawn into the image; names and states live in the strip below the film.
// Positions come from media/film-tracks.json, exported from the
// Blender scene frame by frame (film/blender/export_tracks.py), so every bracket sits on a vehicle
// because the scene put the vehicle there. The state shown for each vehicle is the state the film
// animates at that moment: jamming from 15.6 s, radio loss from 18.6 s, AIR-03 lost at 21.2 s,
// awaiting the operator from 26.3 s.
const $ = (s, r = document) => r.querySelector(s);

export async function startHud({ RM }) {
  const v = $('#filmv'), cv = $('#film-hud'), box = $('#film'), list = $('#inshot'), info = $('#veh-info');
  let T;
  try { T = await (await fetch('media/film-tracks.json')).json(); } catch { cv.hidden = true; return; }
  if (!T || !Array.isArray(T.frames_uv) || T.frames_uv.length !== T.frames) { cv.hidden = true; return; }
  const ctx = cv.getContext('2d'), E = T.events, V = T.vehicles;
  let selected = -1, hover = -1, shotKey = '', posX = 50, visible = true, live = false;
  // hand over from the plain video only once there is a decoded frame to paint
  const goLive = () => { if (live || v.readyState < 2) return; live = true; v.classList.add('composited'); cv.classList.add('on'); };
  v.addEventListener('loadeddata', goLive); v.addEventListener('playing', goLive); goLive();

  const stateOf = (k, t) => {
    const n = V[k].name, air = V[k].kind.startsWith('Fixed');
    if (n === E.lostVehicle && t >= E.lost) return 'LOST · its work shared out by the others';
    if (t >= E.decide) return 'HOLDING · awaiting the operator';
    if (t >= E.lost) return air ? 'RE-SPACING · covering the lost aircraft’s sector' : 'CONTINUING · plan updated';
    if (t >= E.radio) return 'GNSS JAMMED · radio degraded, relaying through peers';
    if (t >= E.jam) return 'GNSS JAMMED · dead reckoning, uncertainty growing';
    return 'GNSS OK · mesh linked';
  };
  const say = (k, t) => { info.textContent = k < 0 ? '' : `${V[k].name} · ${V[k].kind} · ${stateOf(k, t)}`; };

  function fit() {
    const r = box.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  }
  new ResizeObserver(fit).observe(box); fit();
  new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); }).observe(box);

  // object-fit: cover maps the 16:9 frame onto a box of another shape; brackets must use the same map
  function map() {
    const cw = cv.width, ch = cv.height, s = Math.max(cw / T.width, ch / T.height);
    const w = T.width * s, h = T.height * s;
    return { s, w, h, ox: (cw - w) * (posX / 100), oy: (ch - h) / 2 };
  }

  function rebuildList(row, t) {
    const key = row.map(r => r[0]).join(',');
    if (key === shotKey) return; shotKey = key;
    list.textContent = '';
    for (const [k] of row) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = V[k].name;
      b.setAttribute('aria-pressed', String(k === selected));
      b.addEventListener('click', () => { selected = selected === k ? -1 : k; [...list.children].forEach(x => x.setAttribute('aria-pressed', String(x === b && selected === k))); say(selected, v.currentTime); });
      b.addEventListener('focus', () => { hover = k; say(k, v.currentTime); });
      b.addEventListener('blur', () => { hover = -1; say(selected, v.currentTime); });
      list.appendChild(b);
    }
    if (selected >= 0 && !row.some(r => r[0] === selected)) { selected = -1; say(-1, t); }
  }

  function bracket(x, y, s, col, lw) {
    const a = s / 2, l = Math.max(6, s * .28);
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    ctx.moveTo(x - a, y - a + l); ctx.lineTo(x - a, y - a); ctx.lineTo(x - a + l, y - a);
    ctx.moveTo(x + a - l, y - a); ctx.lineTo(x + a, y - a); ctx.lineTo(x + a, y - a + l);
    ctx.moveTo(x + a, y + a - l); ctx.lineTo(x + a, y + a); ctx.lineTo(x + a - l, y + a);
    ctx.moveTo(x - a + l, y + a); ctx.lineTo(x - a, y + a); ctx.lineTo(x - a, y + a - l);
    ctx.stroke();
  }

  let lastRow = [];
  function draw() {
    requestAnimationFrame(draw);
    if (!visible) return;
    const t = v.currentTime || 0, f = Math.min(T.frames - 1, Math.floor(t * T.fps));
    const row = T.frames_uv[f]; lastRow = row;
    rebuildList(row, t);
    // reframe toward the subject when the box crops the frame sideways -- a camera operator, not a zoom
    const focus = row.find(r => r[0] === selected) || row[0];
    if (!RM && focus) { const want = Math.max(0, Math.min(100, focus[1] * 100)); posX += (want - posX) * .06; }
    const m = map(), d = Math.min(devicePixelRatio || 1, 2);
    if (!live) return;
    ctx.fillStyle = '#081012'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(v, m.ox, m.oy, m.w, m.h);
    for (const [k, u, vv, r] of row) {
      const x = m.ox + u * m.w, y = m.oy + vv * m.h, s = Math.max(22 * d, r * m.h * 1.7);
      const lost = V[k].name === E.lostVehicle && t >= E.lost, hot = k === selected || k === hover;
      const col = lost ? '#ff4a2b' : hot ? '#c6f032' : 'rgba(236,231,218,.85)';
      bracket(x, y, s, col, (hot ? 2 : 1.25) * d);
    }
    if (selected >= 0 && Math.floor(t * 4) % 2 === 0) say(selected, t);   // keep the state line current, cheaply
  }
  requestAnimationFrame(draw);

  const pick = e => {
    const r = cv.getBoundingClientRect(), d = cv.width / r.width, px = (e.clientX - r.left) * d, py = (e.clientY - r.top) * d, m = map();
    let best = -1, bd = Infinity;
    for (const [k, u, vv, rr] of lastRow) { const x = m.ox + u * m.w, y = m.oy + vv * m.h, s = Math.max(22 * d, rr * m.h * 1.7), dd = Math.hypot(px - x, py - y); if (dd < s && dd < bd) { bd = dd; best = k; } }
    return best;
  };
  cv.addEventListener('pointermove', e => { const k = pick(e); if (k !== hover) { hover = k; say(k >= 0 ? k : selected, v.currentTime); } });
  cv.addEventListener('pointerleave', () => { hover = -1; say(selected, v.currentTime); });
  cv.addEventListener('click', e => { const k = pick(e); selected = k === selected ? -1 : k; shotKey = ''; say(selected, v.currentTime); });
}
