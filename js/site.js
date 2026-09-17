// Homingvector site shell. Every effect here is driven by state -- film time, scroll position,
// pointer, or a simulation event. Nothing loops for its own sake.
document.documentElement.classList.add('js');
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {                                   // storage can throw (private mode, blocked site data)
  get(k) { try { return sessionStorage.getItem(k) } catch { return null } },
  set(k, v) { try { sessionStorage.setItem(k, v) } catch {} },
};

/* ---------------- boot: first visit only, skippable, never under reduced motion ---------------- */
(() => {
  const boot = $('#boot');
  if (!boot || RM || store.get('hv-boot')) return;
  store.set('hv-boot', '1');
  boot.hidden = false;
  let done = false;
  const end = () => { if (done) return; done = true; boot.classList.add('out'); setTimeout(() => boot.remove(), 230); };
  setTimeout(end, 900);
  addEventListener('keydown', end, { once: true });
  boot.addEventListener('pointerdown', end, { once: true });
})();

/* ---------------- email, assembled here so it is not sitting in the HTML for scrapers ---------------- */
(() => { const a = $('#mail'), u = 'nidhip.sharma.123', d = 'gmail.com'; a.textContent = `${u}@${d}`; a.href = `mailto:${u}@${d}?subject=Homingvector`; })();

/* ---------------- visibility ---------------- */
const watchers = [];
export function watch(el, fn, once) { watchers.push({ el, fn, once, last: null, done: false }); }
function checkViews() {
  const h = innerHeight;
  for (const w of watchers) {
    if (w.done) continue;
    const r = w.el.getBoundingClientRect();
    if (w.once) { if (r.top < h * .92 && r.bottom > 0) { w.done = true; w.fn(true); } }
    else { const vis = r.top < h && r.bottom > 0; if (vis !== w.last) { w.last = vis; w.fn(vis); } }
  }
}
let queued = false;
function queue() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; checkViews(); story(); }); }
addEventListener('scroll', queue, { passive: true });
addEventListener('resize', queue);
$$('.rv').forEach(x => watch(x, () => x.classList.add('in'), true));
$$('.sec').forEach(s => watch(s, () => s.classList.add('arrived'), true));

/* ---------------- sound: off by default, synthesised, only on real events ---------------- */
let actx = null;
const snd = $('#snd');
snd.addEventListener('click', () => {
  const on = snd.getAttribute('aria-pressed') !== 'true';
  snd.setAttribute('aria-pressed', String(on)); snd.textContent = on ? 'Sound on' : 'Sound off';
  if (on && !actx) { try { actx = new AudioContext(); } catch { actx = null; } }
});
export function cue(kind) {
  if (!actx || snd.getAttribute('aria-pressed') !== 'true') return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  if (kind === 'impact') { o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(34, t + .45); g.gain.setValueAtTime(.5, t); g.gain.exponentialRampToValueAtTime(.001, t + .5); }
  else { o.type = 'square'; o.frequency.setValueAtTime(kind === 'good' ? 1320 : 880, t); g.gain.setValueAtTime(.035, t); g.gain.exponentialRampToValueAtTime(.001, t + .05); }
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + .55);
}

/* ---------------- film + strip telemetry (film time is the state) ---------------- */
const CUE = [0, 6, 11, 17, 23, 28.5, 34, 40, 46];
const CH = ['Seventy aircraft, one AI', 'Inside the wedge', 'Air, ground and water', 'GPS jammed', 'Radio degraded, relays climb', 'Aircraft lost, wedge re-forms', 'Split and search', 'Sensor lock', 'A person decides'];
(() => {
  const v = $('#filmv'), steps = $$('.film-steps li'), btn = $('#film-toggle');
  const ft = $('#ft'), fc = $('#fc'), fs = $('#fs');
  // chapters are buttons: jump the film to that moment
  $$('.film-steps button').forEach(b => b.addEventListener('click', () => { try { v.currentTime = +b.dataset.t; } catch {} if (v.paused && !RM) v.play().catch(() => {}); }));
  let userPaused = false, lastIdx = -1;
  const upd = () => {
    const t = v.currentTime || 0; let idx = 0; CUE.forEach((s, i) => { if (t >= s) idx = i; });
    const s = Math.floor(t); ft.textContent = `T+00:${String(s).padStart(2, '0')}`;
    if (idx !== lastIdx) { lastIdx = idx; steps.forEach((li, i) => li.classList.toggle('on', i === idx)); fc.textContent = String(idx + 1).padStart(2, '0'); fs.textContent = CH[idx].toUpperCase(); }
  };
  const setBtn = () => { btn.textContent = v.paused ? 'Play film' : 'Pause film'; btn.setAttribute('aria-pressed', String(!v.paused)); };
  v.addEventListener('timeupdate', upd); v.addEventListener('play', setBtn); v.addEventListener('pause', setBtn);
  const scrub = $('#film-scrub'); let dragging = false;
  v.addEventListener('timeupdate', () => { if (!dragging) scrub.value = String(v.currentTime || 0); });
  scrub.addEventListener('input', () => { dragging = true; try { v.currentTime = +scrub.value; } catch {} });
  scrub.addEventListener('change', () => { dragging = false; });
  btn.addEventListener('click', () => { if (v.paused) { userPaused = false; v.play().catch(() => {}); } else { userPaused = true; v.pause(); } });
  if (RM) { v.removeAttribute('autoplay'); v.pause(); userPaused = true; }
  watch(v, vis => { if (userPaused) return; if (vis) v.play().catch(() => {}); else v.pause(); }, false);
  setBtn(); upd();
})();

/* ---------------- story: loops the film segment for the current step ---------------- */
const SEG = [[0, 11], [6, 11], [11, 17], [17, 23], [23, 28.5], [28.5, 34], [34, 40], [40, 46], [46, 54]];
const sv = $('#storyv'); let svVisible = false, current = -1;
const svPlay = () => { if (!RM) sv.play().catch(() => {}); };
function playSeg(n) {
  const s = SEG[n] || SEG[0];
  const seek = () => { try { sv.currentTime = RM ? Math.min(s[0] + 1.5, s[1] - .1) : s[0]; } catch {} };
  if (sv.readyState >= 1) seek(); else sv.addEventListener('loadedmetadata', seek, { once: true });
  if (svVisible) svPlay();
}
sv.addEventListener('timeupdate', () => { const s = SEG[Math.max(current, 0)]; if (sv.currentTime >= s[1] - .06 || sv.currentTime < s[0] - .6) { try { sv.currentTime = s[0]; } catch {} } });
watch($('.view'), v => { svVisible = v; if (v) svPlay(); else sv.pause(); }, false);
const STATES = ['Formation holding', 'Seventy aircraft linked', 'Cross-domain team', 'GPS jammed', 'Relay ring up', 'Aircraft lost', 'Searching', 'Sensor locked', 'Awaiting operator'];
const chapters = $$('[data-ch]'), cards = $$('#chapters .chapter'), car = $('#chapters'), vstate = $('#vstate'), carPos = $('#car-pos');
const mq = matchMedia('(max-width: 999px)');
window.__chapter = 0;
function setChapter(n) {
  if (n === current) return; current = n; window.__chapter = n;
  chapters.forEach(c => c.classList.toggle('on', +c.dataset.ch === n));
  vstate.textContent = STATES[n];
  playSeg(n);
}
const cardIndex = () => { const w = cards[0].getBoundingClientRect().width + 12; return Math.max(0, Math.min(cards.length - 1, Math.round(car.scrollLeft / w))); };
function story() {
  if (mq.matches) {
    const i = cardIndex(); carPos.textContent = `${i + 1} of ${cards.length}`;
    $('#car-prev').disabled = i === 0; $('#car-next').disabled = i === cards.length - 1;
    setChapter(+cards[i].dataset.ch);
  } else {
    const mid = innerHeight * .5; let best = 0, bd = 1e9;
    chapters.forEach(c => { const r = c.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = +c.dataset.ch; } });
    setChapter(best);
  }
}
car.addEventListener('scroll', queue, { passive: true });
const go = step => { const w = cards[0].getBoundingClientRect().width + 12; car.scrollTo({ left: (cardIndex() + step) * w, behavior: RM ? 'auto' : 'smooth' }); };
$('#car-prev').addEventListener('click', () => go(-1));
$('#car-next').addEventListener('click', () => go(1));
mq.addEventListener('change', () => { current = -1; story(); });

/* ---------------- count-up: verified integers only, snaps to the exact published text ---------------- */
$$('td.v[data-figure]').forEach(td => {
  const text = td.textContent.trim();
  if (!/^\d+$/.test(text) || RM) return;                 // ranges, arrows and "2,000+" are never animated
  const target = +text;
  if (target === 0) return;
  watch(td, () => {
    const t0 = performance.now(), dur = 700;
    const f = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      td.textContent = k < 1 ? String(Math.floor(target * e)) : text;   // never overshoots; ends on the exact string
      if (k < 1) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }, true);
});

/* ---------------- pointer: reticle + magnetic CTAs (fine pointers only) ---------------- */
if (matchMedia('(pointer: fine)').matches && !RM) {
  const ret = $('#reticle'); let px = 0, py = 0, pending = false;
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    px = e.clientX; py = e.clientY; ret.classList.add('on');
    const hot = e.target.closest && e.target.closest('[data-cursor],a,button,canvas');
    const mode = hot ? (hot.dataset.cursor || (hot.tagName === 'CANVAS' ? 'scan' : 'engage')) : '';
    ret.classList.toggle('engage', mode === 'engage'); ret.classList.toggle('scan', mode === 'scan');
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; ret.style.transform = `translate3d(${px}px,${py}px,0)`; }); }
  }, { passive: true });
  document.addEventListener('pointerleave', () => ret.classList.remove('on'));
  addEventListener('keydown', () => ret.classList.remove('on'));
  $$('.mag').forEach(el => {
    el.addEventListener('pointermove', e => { const r = el.getBoundingClientRect(); const dx = (e.clientX - r.left - r.width / 2) / r.width, dy = (e.clientY - r.top - r.height / 2) / r.height; el.style.transform = `translate(${(dx * 8).toFixed(1)}px,${(dy * 6).toFixed(1)}px)`; });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
}

/* ---------------- live simulation: nothing is fetched until the section is near ---------------- */
(() => {
  const rig = $('#rig'); let started = false;
  const start = () => {
    if (started) return; started = true;
    if (!('WebAssembly' in window) || !('Worker' in window)) { $('#rig-fallback').hidden = false; $('.rig-body').hidden = true; $('.tools').hidden = true; return; }
    import('./mission.js').then(m => m.startLive({ watch, cue, RM })).catch(() => { $('#rig-fallback').hidden = false; });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: '600px 0px' });
    io.observe(rig);
  } else start();
})();

/* ---------------- film tracking brackets: loaded after first paint, never blocks it ---------------- */
// Only when the page declares tracks for the film it ships: brackets from one render over another render
// land on empty ground, and a missing file would log a 404 on every visit.
if ($('#filmv').dataset.tracks) addEventListener('load', () => { import('./film-hud.js').then(m => m.startHud({ RM })).catch(() => {}); }, { once: true });

checkViews(); story(); setTimeout(() => { checkViews(); story(); }, 150);
