// Loads sim/tscore.wasm and wraps its C ABI. Shared by the Web Worker and the Node gate, so the
// determinism the gate proves is the determinism the page runs.
// WASI is shimmed to the minimum: the core only writes log lines to stderr, which we discard.
export async function loadCore(bytes) {
  let mem;
  const wasi = {
    fd_write: (fd, iovs, n, nw) => { const v = new DataView(mem.buffer); let t = 0; for (let i = 0; i < n; i++) t += v.getUint32(iovs + 4 + i * 8, true); v.setUint32(nw, t, true); return 0; },
    fd_close: () => 0, fd_seek: () => 70, fd_fdstat_get: () => 8, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 28,
    environ_get: () => 0, environ_sizes_get: (c, s) => { const v = new DataView(mem.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
    args_get: () => 0, args_sizes_get: (c, s) => { const v = new DataView(mem.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
    clock_time_get: (id, p, out) => { new DataView(mem.buffer).setBigUint64(out, 0n, true); return 0; },   // no wall clock may leak in
    random_get: () => 52, proc_exit: (c) => { throw new Error('wasm exit ' + c); }, sched_yield: () => 0,
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: new Proxy(wasi, { get: (o, k) => o[k] || (() => 52) }) });
  const x = instance.exports; mem = x.memory;
  if (x._initialize) x._initialize();
  const dec = new TextDecoder();
  const api = {
    init: (seed) => x.sim_init(seed), step: (n) => x.sim_step(n),
    jam: (a, b, c, d) => x.sim_jam(a, b, c, d), spoof: (a, b, c, d) => x.sim_spoof(a, b, c, d),
    sever: (a, b) => x.sim_sever(a, b), destroy: (i) => x.sim_destroy(i), bandwidth: (f) => x.sim_bandwidth(f),
    time: () => x.sim_time(), hash: () => x.sim_hash(), nv: x.sim_nv(),
    snapshot() {
      const nv = x.sim_nv(), nt = x.sim_ntasks(), p = x.sim_snapshot();
      return new Float64Array(mem.buffer, p, nv * 14 + nt * 4 + nv * nv).slice();
    },
    ntasks: () => x.sim_ntasks(),
    metrics() { return new Float64Array(mem.buffer, x.sim_metrics(), 10).slice(); },
    drainLog() { const n = x.sim_log_len(); if (!n) return ''; const s = dec.decode(new Uint8Array(mem.buffer, x.sim_log_ptr(), n)); x.sim_log_clear(); return s; },
  };
  return api;
}
