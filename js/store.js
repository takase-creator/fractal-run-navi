/* ================= FRACTAL RUN NAVI :: store =================
   All data lives in this browser only (localStorage). Nothing is uploaded.
   ============================================================ */
window.RN = window.RN || {};

RN.store = (function () {
  const NS = 'runnavi.';
  const DEFAULTS = {
    settings: {
      engine: 'osm',           // 'osm' | 'google'
      gkey: '',
      paceSrc: 'auto',         // 'auto' | 'manual'
      paceManual: 360,         // sec/km
      lastKm: 5,
      lastMode: 'loop',        // 'loop' | 'out_back' | 'one_way'
      lastCat: 'any',
      hills: 'any',            // 'any' | 'flat' | 'hilly'
      followMap: true,         // keep the live map centred on the runner
      shareStyle: 'standard',  // 'standard' | 'short' | 'detailed'
      shareTags: '#ランニング #ランナーさんと繋がりたい'
    },
    origins: [],               // [{label, lat, lng, at}]
    runs: [],                  // [{id, start, end, movingSec, dist, path:[[lat,lng,t]], splits:[], plan}]
    saved: [],                 // starred courses, full route objects
    health: null,              // {importedAt, count, workouts:[{start,dist,sec}]}
    poiCache: {}               // key -> {at, items}
  };

  function read(key) {
    try {
      const raw = localStorage.getItem(NS + key);
      if (raw == null) return structuredClone(DEFAULTS[key]);
      const v = JSON.parse(raw);
      if (key === 'settings') return Object.assign(structuredClone(DEFAULTS.settings), v);
      return v;
    } catch (e) { return structuredClone(DEFAULTS[key]); }
  }
  function write(key, val) {
    try { localStorage.setItem(NS + key, JSON.stringify(val)); return true; }
    catch (e) {
      // quota — drop the POI cache first, then the oldest GPS tracks
      if (key !== 'poiCache') { try { localStorage.removeItem(NS + 'poiCache'); } catch (_) { } }
      try { localStorage.setItem(NS + key, JSON.stringify(val)); return true; }
      catch (_) { return false; }
    }
  }

  /* ---------- settings ---------- */
  let _s = read('settings');
  const settings = {
    get all() { return _s; },
    get(k) { return _s[k]; },
    set(k, v) { _s[k] = v; write('settings', _s); return v; },
    patch(o) { Object.assign(_s, o); write('settings', _s); }
  };

  /* ---------- origin history ---------- */
  function origins() { return read('origins'); }
  function addOrigin(o) {
    const list = origins().filter(x => x.label !== o.label);
    list.unshift({ label: o.label, lat: o.lat, lng: o.lng, at: Date.now() });
    write('origins', list.slice(0, 8));
  }

  /* ---------- runs ---------- */
  function runs() { return read('runs'); }
  function addRun(r) {
    const list = runs();
    list.unshift(r);
    // keep full GPS traces for the most recent 40 runs; older ones keep stats only
    list.forEach((x, i) => { if (i >= 40 && x.path) delete x.path; });
    write('runs', list.slice(0, 400));
    return r;
  }
  function deleteRun(id) { write('runs', runs().filter(r => r.id !== id)); }

  /* ---------- saved (starred) courses ----------
     The full route is kept, polyline included, so a saved course opens and
     navigates with no network at all — the point of saving one is to have it
     when you are already outside.                                          */
  function saved() { return read('saved'); }
  function isSaved(id) { return saved().some(r => r.id === id); }
  function saveCourse(route) {
    const list = saved().filter(r => r.id !== route.id);
    list.unshift(Object.assign({}, route, { savedAt: Date.now() }));
    write('saved', list.slice(0, 60));
    return true;
  }
  function unsaveCourse(id) { write('saved', saved().filter(r => r.id !== id)); }
  function toggleSave(route) {
    if (isSaved(route.id)) { unsaveCourse(route.id); return false; }
    saveCourse(route); return true;
  }

  /* ---------- apple health ---------- */
  function health() { return read('health'); }
  function setHealth(h) { write('health', h); }

  /* ---------- POI cache (7 days) ---------- */
  const CACHE_TTL = 7 * 24 * 3600e3;
  function cacheGet(key) {
    const c = read('poiCache')[key];
    if (!c || Date.now() - c.at > CACHE_TTL) return null;
    return c.items;
  }
  function cacheSet(key, items) {
    const c = read('poiCache');
    c[key] = { at: Date.now(), items };
    // cap at 60 entries, drop oldest
    const keys = Object.keys(c);
    if (keys.length > 60) {
      keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - 60).forEach(k => delete c[k]);
    }
    write('poiCache', c);
  }

  /* ---------- pace model ----------
     Priority: manual (if selected) > recorded runs > Apple Health import > 6:00/km
     Recorded runs are weighted towards recent + similar distance.                */
  function paceModel(targetMeters) {
    if (_s.paceSrc === 'manual') {
      return { sec: _s.paceManual, src: '手動設定', n: 0 };
    }
    const mine = runs().filter(r => r.dist > 800 && r.movingSec > 240)
      .map(r => ({ at: r.start, sec: r.movingSec / (r.dist / 1000), dist: r.dist }));
    const hw = (health() && health().workouts || [])
      .filter(w => w.dist > 800 && w.sec > 240)
      .map(w => ({ at: w.start, sec: w.sec / (w.dist / 1000), dist: w.dist }));

    const pool = mine.concat(hw)
      .filter(x => x.sec > 150 && x.sec < 1200)          // 2:30–20:00 /km sanity window
      .sort((a, b) => b.at - a.at)
      .slice(0, 30);

    if (!pool.length) return { sec: _s.paceManual, src: '未計測（既定値）', n: 0 };

    const now = Date.now();
    let wsum = 0, vsum = 0;
    for (const x of pool) {
      const ageDays = Math.max(0, (now - x.at) / 864e5);
      const wRecent = Math.exp(-ageDays / 90);                       // 90-day half-life-ish
      const wDist = targetMeters
        ? Math.exp(-Math.abs(Math.log((x.dist || 5000) / targetMeters)) * 1.2) : 1;
      const w = wRecent * wDist + 0.02;
      wsum += w; vsum += w * x.sec;
    }
    const src = mine.length && hw.length ? `記録${mine.length}本＋ヘルスケア${hw.length}本`
      : mine.length ? `アプリの記録${mine.length}本` : `ヘルスケア${hw.length}本`;
    return { sec: vsum / wsum, src, n: pool.length };
  }

  function wipe() {
    Object.keys(DEFAULTS).forEach(k => { try { localStorage.removeItem(NS + k); } catch (e) { } });
    _s = read('settings');
  }

  return {
    settings, origins, addOrigin, runs, addRun, deleteRun,
    saved, isSaved, saveCourse, unsaveCourse, toggleSave,
    health, setHealth, cacheGet, cacheSet, paceModel, wipe
  };
})();
