/* ================= FRACTAL RUN NAVI :: planner =================
   Turns "出発地 + 走りたい距離 + コースの形" into real walking/running
   routes that pass through the most-reviewed places nearby.

   Geometry
   --------
   one_way   : origin -> P              , |route| ~= T
   out_back  : origin -> P -> origin    , |route| ~= T   (P at ~T/2)
   loop      : origin -> W1..Wn -> origin, modelled as a regular (n+1)-gon
               with the origin as one vertex. For a polygon of V vertices and
               circumradius Rc the perimeter is V*2*Rc*sin(pi/V), so

                   Rc = T / (detour * V * 2 * sin(pi/V))

               The polygon centre sits Rc from the origin on bearing theta0;
               sweeping theta0 gives structurally different loops.

   API budget
   ----------
   Candidates are first ranked with a straight-line estimate (free), only the
   survivors are actually routed, and the detour factor is re-learned from the
   first real route so the refinement pass converges in one step.
   ============================================================== */
window.RN = window.RN || {};

RN.planner = (function () {
  const U = RN.util;

  const DETOUR_DEFAULT = 1.28;      // road distance / straight-line, dense JP city
  const MODE_LABEL = { loop: '周回', out_back: '往復', one_way: '片道' };

  /* ---------- geometry helpers ---------- */

  /** vertices of the loop polygon (excluding the origin) */
  function loopVertices(origin, Rc, V, theta0) {
    const centre = U.destPoint(origin, theta0, Rc);
    // bearing from centre back to origin
    const b0 = U.bearing(centre, origin);
    const out = [];
    for (let i = 1; i < V; i++) out.push(U.destPoint(centre, b0 + i * 360 / V, Rc));
    return out;
  }

  function polygonPerimeter(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += U.haversine(pts[i - 1], pts[i]);
    return s;
  }

  /** straight-line length of origin -> pts... -> (origin for closed shapes) */
  function chainLength(origin, pts, closed) {
    const seq = [origin].concat(pts);
    if (closed) seq.push(origin);
    return polygonPerimeter(seq);
  }

  /* ---------- snapping ideal points to real places ---------- */

  /**
   * Pick the best POI near an ideal position.
   * Popularity is the payload; distance from the ideal point is the cost,
   * because moving a stop distorts the total route length.
   */
  function snap(ideal, pois, snapR, used, kindsUsed) {
    let best = null, bestScore = -1e9, bestAt = null;
    for (const p of pois) {
      if (used.has(p.id)) continue;
      // for an area feature the stop is wherever the route meets it, not its centre
      const at = (p.bb && RN.providers.clampToBB(p.bb, ideal)) || { lat: p.lat, lng: p.lng };
      const d = U.haversine(ideal, at);
      if (d > snapR) continue;
      let s = p.pop - (d / snapR) * 38;
      if (kindsUsed && kindsUsed.has(p.kind)) s -= 12;   // encourage variety
      if (s > bestScore) { bestScore = s; best = p; bestAt = at; }
    }
    if (!best) return null;
    return (bestAt.lat === best.lat && bestAt.lng === best.lng)
      ? best
      : Object.assign({}, best, { lat: bestAt.lat, lng: bestAt.lng });
  }

  /** synthetic stop when nothing notable exists out there */
  function ghost(ideal, i) {
    return {
      id: 'ghost/' + i + '/' + ideal.lat.toFixed(4) + ',' + ideal.lng.toFixed(4),
      name: '折り返し地点', lat: ideal.lat, lng: ideal.lng,
      pop: 0, reviews: null, rating: null, kind: 'attraction', url: null, ghost: true
    };
  }

  /* ---------- candidate construction ---------- */

  function buildLoopCandidate(origin, pois, T, detour, V, theta0) {
    const Rc = T / (detour * V * 2 * Math.sin(Math.PI / V));
    const side = 2 * Rc * Math.sin(Math.PI / V);
    const snapR = Math.max(200, side * 0.34);
    const ideals = loopVertices(origin, Rc, V, theta0);
    const used = new Set(), kinds = new Set();
    const stops = ideals.map((pt, i) => {
      const p = snap(pt, pois, snapR, used, kinds);
      if (p) { used.add(p.id); kinds.add(p.kind); return p; }
      return ghost(pt, i);
    });
    return { mode: 'loop', theta0, Rc, V, stops, est: chainLength(origin, stops, true) * detour };
  }

  /** where along the way to `poi` should the turnaround sit? */
  function entryPoint(origin, poi, wantStraight) {
    if (!poi.bb) return poi;
    const { near, far } = RN.providers.bbRange(origin, poi.bb);
    const s = Math.max(near, Math.min(far, wantStraight));
    const aim = U.destPoint(origin, U.bearing(origin, poi), s);
    const at = RN.providers.clampToBB(poi.bb, aim);
    return Object.assign({}, poi, { lat: at.lat, lng: at.lng });
  }

  /** @param straight desired straight-line distance to the turnaround */
  function buildRadialCandidate(origin, straight, detour, closed, poi) {
    const stop = entryPoint(origin, poi, straight);
    return {
      mode: closed ? 'out_back' : 'one_way',
      stops: [stop],
      est: U.haversine(origin, stop) * detour * (closed ? 2 : 1)
    };
  }

  /* ---------- scoring ---------- */

  function fitness(actual, target) {
    const err = Math.abs(actual - target) / target;
    return { err, fit: Math.max(0, 1 - err / 0.28) };
  }

  function scoreRoute(r, target) {
    const { err, fit } = fitness(r.distance, target);
    const real = r.stops.filter(s => !s.ghost);
    const popAvg = real.length ? real.reduce((a, s) => a + s.pop, 0) / real.length : 0;
    const popMax = real.length ? Math.max(...real.map(s => s.pop)) : 0;
    const coverage = r.stops.length ? real.length / r.stops.length : 0;
    r.err = err;
    r.baseScore = 46 * fit + 0.34 * popAvg + 0.14 * popMax + 8 * coverage;
    r.score = r.baseScore;
    return r;
  }

  /** re-rank once elevation is known. Always recomputes from `baseScore` so
      switching back to おまかせ restores the neutral order. */
  function applyHillPreference(routes, pref, target) {
    for (const r of routes) {
      if (r.baseScore == null) r.baseScore = r.score;
      if (!pref || pref === 'any' || !r.elev) { r.score = r.baseScore; continue; }
      const perKm = r.elev.gain / Math.max(0.2, r.distance / 1000);
      // 25 m/km of climbing is a properly hilly city route; scale against that
      const hilliness = Math.min(1, perKm / 25);
      r.score = r.baseScore + (pref === 'flat' ? -26 * hilliness : 22 * hilliness);
    }
    routes.sort((a, b) => b.score - a.score);
    return routes;
  }

  /* ---------- main ---------- */

  /**
   * @param {object} o
   *   provider, origin {lat,lng,label}, targetMeters, mode, category,
   *   hills ('any'|'flat'|'hilly'), exclude (Set of stop ids to avoid),
   *   onProgress(frac, text), onPartial(routes) — fired as soon as the first
   *   real route exists so the UI need not wait for the whole search,
   *   signal (AbortSignal-ish {aborted})
   * @returns {Promise<Array>} up to 3 routes, best first
   */
  async function plan(o) {
    const { provider, origin, targetMeters: T, mode, category } = o;
    const prog = o.onProgress || function () { };
    const partial = o.onPartial || function () { };
    const exclude = o.exclude instanceof Set ? o.exclude : new Set();
    const stop = () => { if (o.signal && o.signal.aborted) throw new Error('ABORT'); };

    let detour = DETOUR_DEFAULT;

    /* --- 1. where should the far point(s) sit? --- */
    const V = mode === 'loop' ? (T < 4000 ? 3 : 4) : 0;
    let ringMid, ringIn, ringOut;
    if (mode === 'loop') {
      const Rc = T / (detour * V * 2 * Math.sin(Math.PI / V));
      // vertex i of the polygon sits 2*Rc*sin(i*pi/V) from the origin, so the
      // stops live in a band, not on a circle. Searching the true band keeps the
      // Overpass query small — a wrong band is both slower and worse.
      const dMin = 2 * Rc * Math.sin(Math.PI / V);
      const dMax = 2 * Rc * Math.sin(Math.PI * Math.floor(V / 2) / V);
      // room for the refinement pass; short loops need a wider net because the
      // band is only a few hundred metres thick and would otherwise be empty
      const slack = Rc > 1500 ? [0.88, 1.14] : Rc > 500 ? [0.80, 1.26] : [0.55, 1.70];
      ringMid = Rc;
      ringIn = dMin * slack[0]; ringOut = dMax * slack[1];
    } else {
      const leg = mode === 'out_back' ? T / 2 : T;
      ringMid = leg / detour;
      ringIn = ringMid * 0.70; ringOut = ringMid * 1.26;
    }

    /* --- 2. collect popular places in that band --- */
    prog(0.05, '人気スポットを探しています…');
    let pois = [];
    try {
      pois = await provider.searchRing({
        center: origin, rInner: ringIn, rOuter: ringOut, category,
        onProgress: f => prog(0.05 + 0.35 * f, '人気スポットを探しています…')
      });
    } catch (e) {
      console.warn('searchRing', e);
    }
    stop();
    // "もう一度探す" pushes the previous picks to the back rather than banning
    // them, so a thin area still returns something instead of nothing
    if (exclude.size) pois = pois.map(p => exclude.has(p.id) ? Object.assign({}, p, { pop: p.pop * 0.25 }) : p);
    prog(0.42, `${pois.length}件の候補からコースを組み立てています…`);

    /* --- 3. cheap candidate generation --- */
    let cands = [];
    if (mode === 'loop') {
      const bearings = [0, 60, 120, 180, 240, 300, 30, 150, 270];
      for (const b of bearings) cands.push(buildLoopCandidate(origin, pois, T, detour, V, b));
      // prefer loops whose stops are actually real and popular, and whose
      // straight-line estimate already lands near the target
      cands.forEach(c => {
        const real = c.stops.filter(s => !s.ghost);
        const pop = real.length ? real.reduce((a, s) => a + s.pop, 0) / c.stops.length : 0;
        c.pre = pop * 0.7 + 40 * fitness(c.est, T).fit;
      });
      cands.sort((a, b) => b.pre - a.pre);
      // keep bearings spread apart so the 3 results look different
      const picked = [];
      for (const c of cands) {
        if (picked.length >= 4) break;
        if (picked.some(p => {
          const d = Math.abs(p.theta0 - c.theta0) % 360;
          return Math.min(d, 360 - d) < 50;
        })) continue;
        picked.push(c);
      }
      cands = picked.length ? picked : cands.slice(0, 4);
    } else {
      const leg = mode === 'out_back' ? T / 2 : T;
      const closed = mode === 'out_back';
      const straight = leg / detour;
      const scored = pois.map(p => {
        const c = buildRadialCandidate(origin, straight, detour, closed, p);
        return { p, c, pre: p.pop * 0.7 + 40 * fitness(c.est, T).fit };
      }).sort((a, b) => b.pre - a.pre);

      const picked = [];
      for (const s of scored) {
        if (picked.length >= 5) break;
        // spread the destinations around so the results are not all the same street
        if (picked.some(q => U.haversine(q.c.stops[0], s.c.stops[0]) < leg * 0.35)) continue;
        picked.push(s);
      }
      cands = (picked.length ? picked : scored.slice(0, 5)).map(s => s.c);

      if (!cands.length) {   // nothing found — still give a route of the right length
        for (const b of [0, 90, 180, 270]) {
          const pt = U.destPoint(origin, b, straight);
          cands.push(buildRadialCandidate(origin, straight, detour, closed, ghost(pt, b)));
        }
        cands = cands.slice(0, 4);
      }
    }

    /* --- 4. route the survivors for real --- */
    const routed = [];
    const total = cands.length;
    let lastErr = null;
    for (let i = 0; i < cands.length; i++) {
      stop();
      prog(0.45 + 0.35 * (i / total), `ルートを計算中 ${i + 1}/${total}…`);
      const c = cands[i];
      try {
        const pts = [origin].concat(c.stops.map(s => ({ lat: s.lat, lng: s.lng })));
        if (c.mode !== 'one_way') pts.push(origin);
        const r = await provider.route(pts);
        // learn the real detour factor from the first successful route
        const straight = chainLength(origin, c.stops, c.mode !== 'one_way');
        if (straight > 200) {
          const f = r.distance / straight;
          if (f > 1.02 && f < 2.4) detour = detour * 0.5 + f * 0.5;
        }
        routed.push(scoreRoute(Object.assign({}, c, {
          distance: r.distance, path: r.path, osrmDuration: r.duration
        }), T));
        // hand the UI something to show while the rest are still routing
        partial(decorate(routed.slice().sort((a, b) => b.score - a.score), origin, T, category));
      } catch (e) {
        if (String(e.message) === 'ABORT') throw e;
        lastErr = e;
        console.warn('route failed', e && e.message);
      }
    }
    stop();
    if (!routed.length) {
      throw new Error(pois.length === 0 && lastErr
        ? '地図サーバーが混雑しています。1〜2分おいてもう一度お試しください。'
        : 'ルートを引けませんでした。出発地や距離を少し変えて試してください。');
    }

    /* --- 5. one refinement pass on the best few --- */
    routed.sort((a, b) => b.score - a.score);
    const toFix = routed.slice(0, 3).filter(r => r.err > 0.10);
    for (let i = 0; i < toFix.length; i++) {
      stop();
      prog(0.80 + 0.15 * (i / Math.max(1, toFix.length)), '距離を合わせています…');
      const r = toFix[i];
      const k = T / r.distance;                 // scale the shape towards the target
      try {
        let c;
        if (r.mode === 'loop') {
          c = buildLoopCandidate(origin, pois, T, detour / k, r.V, r.theta0);
        } else {
          const closed = r.mode === 'out_back';
          const wantStraight = (closed ? T / 2 : T) / detour * k;
          const target = U.destPoint(origin, U.bearing(origin, r.stops[0]), wantStraight);
          const p = snap(target, pois, wantStraight * 0.35, new Set(), null) || ghost(target, 9);
          c = buildRadialCandidate(origin, wantStraight, detour, closed, p);
        }
        const pts = [origin].concat(c.stops.map(s => ({ lat: s.lat, lng: s.lng })));
        if (c.mode !== 'one_way') pts.push(origin);
        const rr = await provider.route(pts);
        const better = scoreRoute(Object.assign({}, c, {
          distance: rr.distance, path: rr.path, osrmDuration: rr.duration
        }), T);
        if (better.score > r.score) Object.assign(r, better);
      } catch (e) {
        if (String(e.message) === 'ABORT') throw e;
      }
    }

    /* --- 6. measure the hills, then finish --- */
    routed.sort((a, b) => b.score - a.score);
    let final = dedupeRoutes(routed, 3);

    if (RN.terrain) {
      prog(0.96, '高低差を調べています…');
      try {
        await RN.terrain.annotate(final);
        applyHillPreference(final, o.hills, T);
      } catch (e) { console.warn('terrain', e && e.message); }
    }
    stop();
    prog(1, '完了');
    return decorate(final, origin, T, category);
  }

  function dedupeRoutes(routed, max) {
    const out = [];
    for (const r of routed) {
      const head = (r.stops.find(s => !s.ghost) || r.stops[0]).id;
      if (out.some(f => (f.stops.find(s => !s.ghost) || f.stops[0]).id === head)) continue;
      out.push(r);
      if (out.length >= max) break;
    }
    return out;
  }

  /** stamp the display fields a route needs once it leaves the planner */
  function decorate(routes, origin, T, category) {
    const list = dedupeRoutes(routes, 3);
    return list.map((r, i) => Object.assign(r, {
      id: r.id || ('route-' + Math.abs(Math.round(r.distance)) + '-' +
        (r.stops[0] ? r.stops[0].id.replace(/[^a-z0-9]/gi, '') : i)),
      rank: i + 1,
      target: T,
      origin: { lat: origin.lat, lng: origin.lng, label: origin.label },
      modeLabel: MODE_LABEL[r.mode],
      category
    }));
  }

  /* ---------- Google Maps hand-off ----------
     Maps URLs allows 3 waypoints on mobile browsers, 9 elsewhere.        */
  function mapsUrl(route) {
    const c = p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    const o = route.origin;
    const stops = route.stops.slice();
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    const maxWp = isMobile ? 3 : 9;

    let dest, wps;
    if (route.mode === 'one_way') {
      dest = stops.pop();
      wps = stops;
    } else {
      dest = o;
      wps = stops;
    }
    if (wps.length > maxWp) {
      // keep the most popular stops, preserving order
      const keep = wps.slice().sort((a, b) => b.pop - a.pop).slice(0, maxWp);
      wps = wps.filter(w => keep.includes(w));
    }
    const q = new URLSearchParams({
      api: '1',
      origin: c(o),
      destination: c(dest),
      travelmode: 'walking'
    });
    if (wps.length) q.set('waypoints', wps.map(c).join('|'));
    return 'https://www.google.com/maps/dir/?' + q.toString();
  }

  /** how far along `path` is `pt`, and how far off it — for live run guidance */
  function locateOnPath(path, pt) {
    if (!path || path.length < 2) return null;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < path.length; i++) {
      const d = U.haversine(path[i], pt);
      if (d < bestD) { bestD = d; best = i; }
    }
    let done = 0;
    for (let i = 1; i <= best; i++) done += U.haversine(path[i - 1], path[i]);
    return { index: best, along: done, offRoute: bestD };
  }

  return { plan, mapsUrl, MODE_LABEL, locateOnPath, applyHillPreference };
})();
