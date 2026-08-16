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
    let best = null, bestScore = -1e9;
    for (const p of pois) {
      if (used.has(p.id)) continue;
      const d = U.haversine(ideal, p);
      if (d > snapR) continue;
      let s = p.pop - (d / snapR) * 38;
      if (kindsUsed && kindsUsed.has(p.kind)) s -= 12;   // encourage variety
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
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

  function buildRadialCandidate(origin, pois, legTarget, detour, closed, poi) {
    return {
      mode: closed ? 'out_back' : 'one_way',
      stops: [poi],
      est: U.haversine(origin, poi) * detour * (closed ? 2 : 1)
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
    r.score = 46 * fit + 0.34 * popAvg + 0.14 * popMax + 8 * coverage;
    return r;
  }

  /* ---------- main ---------- */

  /**
   * @param {object} o
   *   provider, origin {lat,lng,label}, targetMeters, mode, category,
   *   onProgress(frac, text), signal (AbortSignal-ish {aborted})
   * @returns {Promise<Array>} up to 3 routes, best first
   */
  async function plan(o) {
    const { provider, origin, targetMeters: T, mode, category } = o;
    const prog = o.onProgress || function () { };
    const stop = () => { if (o.signal && o.signal.aborted) throw new Error('ABORT'); };

    let detour = DETOUR_DEFAULT;

    /* --- 1. where should the far point(s) sit? --- */
    const V = mode === 'loop' ? (T < 4000 ? 3 : 4) : 0;
    let ringMid, ringIn, ringOut;
    if (mode === 'loop') {
      ringMid = T / (detour * V * 2 * Math.sin(Math.PI / V));           // = Rc
      // vertices sit between ~Rc and ~2*Rc*sin(pi/V) from the origin
      ringIn = ringMid * 0.62; ringOut = ringMid * 1.95;
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
      const scored = pois.map(p => {
        const est = U.haversine(origin, p) * detour * (closed ? 2 : 1);
        return { p, pre: p.pop * 0.7 + 40 * fitness(est, T).fit };
      }).sort((a, b) => b.pre - a.pre);

      const picked = [];
      for (const s of scored) {
        if (picked.length >= 5) break;
        // spread the destinations around so the results are not all the same street
        if (picked.some(q => U.haversine(q.p, s.p) < leg * 0.35)) continue;
        picked.push(s);
      }
      cands = (picked.length ? picked : scored.slice(0, 5))
        .map(s => buildRadialCandidate(origin, pois, leg, detour, closed, s.p));

      if (!cands.length) {   // nothing found — still give a route of the right length
        for (const b of [0, 90, 180, 270]) {
          const pt = U.destPoint(origin, b, leg / detour);
          cands.push(buildRadialCandidate(origin, pois, leg, detour, closed, ghost(pt, b)));
        }
        cands = cands.slice(0, 4);
      }
    }

    /* --- 4. route the survivors for real --- */
    const routed = [];
    const total = cands.length;
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
      } catch (e) {
        if (String(e.message) === 'ABORT') throw e;
        console.warn('route failed', e && e.message);
      }
    }
    stop();
    if (!routed.length) throw new Error('ルートを引けませんでした。出発地を少し変えて試してください。');

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
          const wantLeg = (closed ? T / 2 : T) / detour * k;
          const target = U.destPoint(origin, U.bearing(origin, r.stops[0]), wantLeg);
          const p = snap(target, pois, wantLeg * 0.35, new Set(), null) || ghost(target, 9);
          c = buildRadialCandidate(origin, pois, wantLeg, detour, closed, p);
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

    /* --- 6. finish --- */
    prog(1, '完了');
    routed.sort((a, b) => b.score - a.score);

    // drop near-duplicate routes (same headline stop)
    const final = [];
    for (const r of routed) {
      const head = (r.stops.find(s => !s.ghost) || r.stops[0]).id;
      if (final.some(f => (f.stops.find(s => !s.ghost) || f.stops[0]).id === head)) continue;
      final.push(r);
      if (final.length >= 3) break;
    }

    return final.map((r, i) => Object.assign(r, {
      id: 'route-' + Date.now().toString(36) + '-' + i,
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

  return { plan, mapsUrl, MODE_LABEL };
})();
