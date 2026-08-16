/* ================= FRACTAL RUN NAVI :: util ================= */
window.RN = window.RN || {};

RN.util = (function () {
  const R = 6371008.8; // mean earth radius (m)
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;

  /** great-circle distance in metres */
  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** point at `dist` metres on `bearing` degrees from `p` */
  function destPoint(p, bearingDeg, dist) {
    const br = rad(bearingDeg), d = dist / R;
    const lat1 = rad(p.lat), lng1 = rad(p.lng);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
    const lng2 = lng1 + Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /** bbox [south,west,north,east] around p with radius metres */
  function bbox(p, r) {
    const dLat = deg(r / R);
    const dLng = deg(r / (R * Math.cos(rad(p.lat))));
    return [p.lat - dLat, p.lng - dLng, p.lat + dLat, p.lng + dLng];
  }

  /** cumulative length (m) of a [{lat,lng}] path */
  function pathLength(path) {
    let s = 0;
    for (let i = 1; i < path.length; i++) s += haversine(path[i - 1], path[i]);
    return s;
  }

  /* ---------- formatting ---------- */
  const pad2 = n => String(n).padStart(2, '0');

  /** seconds -> "h:mm:ss" or "m:ss" */
  function hms(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  /** seconds per km -> "m'ss"" style "5:30" */
  function pace(secPerKm) {
    if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '–:––';
    const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
    return s === 60 ? `${m + 1}:00` : `${m}:${pad2(s)}`;
  }
  const km = m => (m / 1000).toFixed(2);
  const km1 = m => (m / 1000).toFixed(1);

  function nfmt(n) {
    if (n == null) return '–';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  function ymd(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  }
  function ymdhm(ts) {
    const d = new Date(ts);
    return `${ymd(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /* ---------- async helpers ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /**
   * Serialised queue guaranteeing >= gapMs between calls (API politeness).
   * The queue tail must never be left in a rejected state: `p.then(fn)` on a
   * rejected promise skips fn and re-throws, so one failed request would
   * otherwise poison every later call through the same limiter.
   */
  function rateLimiter(gapMs) {
    let last = 0, chain = Promise.resolve();
    const gap = typeof gapMs === 'function' ? gapMs : () => gapMs;
    return fn => {
      const run = chain.then(async () => {
        const wait = gap() - (performance.now() - last);
        if (wait > 0) await sleep(wait);
        last = performance.now();
        return fn();
      });
      chain = run.then(() => { }, () => { });
      return run;
    };
  }

  /** HTTP status carried on the error so callers can distinguish 429 from 404 */
  function httpStatus(err) {
    const m = /HTTP (\d{3})/.exec(String(err && err.message));
    return m ? +m[1] : 0;
  }

  async function fetchJSON(url, opt) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (opt && opt.timeout) || 20000);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opt));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  /* ---------- dom ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4200 : 2600);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  return {
    haversine, destPoint, bearing, bbox, pathLength,
    hms, pace, km, km1, nfmt, ymd, ymdhm, pad2,
    sleep, rateLimiter, fetchJSON, httpStatus,
    $, $$, el, esc, toast, download
  };
})();
