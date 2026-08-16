/* ================= FRACTAL RUN NAVI :: terrain =================
   Elevation for a route, via Open-Meteo (free, no key, CORS-enabled).

   A 5 km "flat" city loop and a 5 km loop with 90 m of climbing are completely
   different runs, so every candidate course is measured before it is shown.
   Samples for all candidates are batched into as few requests as possible and
   cached, because the same course is usually looked at more than once.
   =============================================================== */
window.RN = window.RN || {};

RN.terrain = (function () {
  const U = RN.util;
  const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
  const MAX_PER_CALL = 100;
  const NOISE = 1.5;          // m — DEM noise floor; smaller wiggles are not hills

  const memo = new Map();     // "lat,lng" (4dp) -> metres

  const key = p => p.lat.toFixed(4) + ',' + p.lng.toFixed(4);

  /** resample a polyline to `n` evenly spaced points (by distance) */
  function resample(path, n) {
    if (!path || path.length < 2) return path ? path.slice() : [];
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + U.haversine(path[i - 1], path[i]);
    const total = cum[cum.length - 1];
    if (total <= 0) return [path[0]];
    const out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = total * i / (n - 1);
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j];
      const t = seg > 0 ? (d - cum[j]) / seg : 0;
      out.push({
        lat: path[j].lat + (path[j + 1].lat - path[j].lat) * t,
        lng: path[j].lng + (path[j + 1].lng - path[j].lng) * t
      });
    }
    return out;
  }

  async function lookup(points) {
    const need = [];
    for (const p of points) if (!memo.has(key(p))) need.push(p);

    for (let i = 0; i < need.length; i += MAX_PER_CALL) {
      const chunk = need.slice(i, i + MAX_PER_CALL);
      const url = ENDPOINT
        + '?latitude=' + chunk.map(p => p.lat.toFixed(5)).join(',')
        + '&longitude=' + chunk.map(p => p.lng.toFixed(5)).join(',');
      const r = await U.fetchJSON(url, { timeout: 15000 });
      const el = r && r.elevation;
      if (!el || el.length !== chunk.length) throw new Error('elevation mismatch');
      chunk.forEach((p, k) => memo.set(key(p), el[k]));
    }
    return points.map(p => memo.get(key(p)));
  }

  /** cumulative ascent / descent / max gradient over a sampled profile */
  function summarise(elev, totalMeters) {
    let up = 0, down = 0, minE = Infinity, maxE = -Infinity, maxGrade = 0;
    const step = totalMeters / Math.max(1, elev.length - 1);
    for (let i = 0; i < elev.length; i++) {
      const e = elev[i];
      if (e == null || !isFinite(e)) continue;
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      if (i === 0) continue;
      const d = e - elev[i - 1];
      if (Math.abs(d) < NOISE) continue;                 // DEM jitter, not a hill
      if (d > 0) up += d; else down -= d;
      maxGrade = Math.max(maxGrade, Math.abs(d) / step);
    }
    return {
      gain: Math.round(up), loss: Math.round(down),
      min: isFinite(minE) ? Math.round(minE) : null,
      max: isFinite(maxE) ? Math.round(maxE) : null,
      maxGrade: +(maxGrade * 100).toFixed(1),
      profile: elev
    };
  }

  /** 平坦 / ゆるやか / アップダウンあり / 坂が多い  (gain per km) */
  function label(gain, meters) {
    const perKm = meters > 0 ? gain / (meters / 1000) : 0;
    if (perKm < 6) return { text: '平坦', level: 0 };
    if (perKm < 15) return { text: 'ゆるやか', level: 1 };
    if (perKm < 30) return { text: 'アップダウンあり', level: 2 };
    return { text: '坂が多い', level: 3 };
  }

  /**
   * Attach `elev` to each route. Samples are pooled across routes so a set of
   * four candidates costs one or two HTTP calls, not four.
   */
  async function annotate(routes, samplesPerRoute) {
    const n = samplesPerRoute || 34;
    const jobs = routes.map(r => ({ r, pts: resample(r.path || [], n) }));
    const all = [];
    jobs.forEach(j => all.push(...j.pts));
    if (!all.length) return routes;
    try {
      await lookup(all);
    } catch (e) {
      console.warn('elevation unavailable', e && e.message);
      return routes;
    }
    for (const j of jobs) {
      const el = j.pts.map(p => memo.get(key(p)));
      if (el.some(v => v == null)) continue;
      j.r.elev = summarise(el, j.r.distance);
      j.r.elev.label = label(j.r.elev.gain, j.r.distance);
    }
    return routes;
  }

  /** inline SVG elevation profile, theme-coloured, no external deps */
  function sparkline(elev, w, h) {
    const p = elev && elev.profile;
    if (!p || p.length < 3) return '';
    w = w || 300; h = h || 54;
    const lo = Math.min(...p), hi = Math.max(...p);
    const span = Math.max(6, hi - lo);            // never exaggerate a flat course
    const mid = (hi + lo) / 2;
    const y0 = mid - span / 2;
    const x = i => (i / (p.length - 1)) * w;
    const y = v => h - 4 - ((v - y0) / span) * (h - 12);
    const line = p.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${w},${h}L0,${h}Z`;
    return `<svg class="elev-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#00e5a0" stop-opacity=".45"/>
        <stop offset="1" stop-color="#00e5a0" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#eg)"/>
      <path d="${line}" fill="none" stroke="#00e5a0" stroke-width="1.8"
            stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  return { annotate, resample, lookup, summarise, label, sparkline };
})();
