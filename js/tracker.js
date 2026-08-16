/* ================= FRACTAL RUN NAVI :: tracker =================
   GPS run recording.

   iOS Safari only delivers position updates while the page is in the
   foreground, so a Screen Wake Lock is taken for the duration of the run and
   the in-progress state is mirrored to localStorage every few seconds — an
   accidental reload or a phone call resumes instead of losing the run.
   =============================================================== */
window.RN = window.RN || {};

RN.tracker = (function () {
  const U = RN.util;
  const LIVE_KEY = 'runnavi.live';

  const MAX_ACC = 35;        // m — discard fixes worse than this
  const MAX_SPEED = 8;       // m/s — 28.8 km/h, above this it is a GPS jump
  const MIN_STEP = 4;        // m — ignore jitter while standing still
  const MOVING_MIN = 0.6;    // m/s — below this we are not running

  let st = null;             // live run state
  let watchId = null;
  let wakeLock = null;
  let ticker = null;
  let listeners = [];

  function emit() { listeners.forEach(f => { try { f(snapshot()); } catch (e) { } }); }
  function on(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; }

  function blank(plan, course) {
    return {
      course: course || null,   // the planned route, kept for the live map
      id: 'run-' + Date.now().toString(36),
      start: Date.now(),
      end: null,
      dist: 0,
      movingSec: 0,
      elapsedSec: 0,
      path: [],            // [lat, lng, tMs, accuracy]
      splits: [],          // [{km, sec}]
      lastSplitDist: 0,
      lastSplitSec: 0,
      paused: false,
      recentSpeed: 0,
      plan: plan || null   // {routeId, name, distance, mode}
    };
  }

  async function lockScreen() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { wakeLock = null; }
  }
  function releaseScreen() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { }
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st && !st.paused && !wakeLock) lockScreen();
  });

  function onPos(pos) {
    if (!st || st.paused) return;
    const c = pos.coords;
    const t = pos.timestamp || Date.now();
    if (c.accuracy != null && c.accuracy > MAX_ACC) { st.gpsAcc = c.accuracy; emit(); return; }
    st.gpsAcc = c.accuracy;

    const p = [c.latitude, c.longitude, t, Math.round(c.accuracy || 0)];
    const prev = st.path[st.path.length - 1];

    if (!prev) { st.path.push(p); emit(); return; }

    const dt = (t - prev[2]) / 1000;
    if (dt <= 0) return;
    const d = U.haversine({ lat: prev[0], lng: prev[1] }, { lat: c.latitude, lng: c.longitude });
    const v = d / dt;

    if (v > MAX_SPEED) return;                 // teleport — drop it
    if (d < MIN_STEP && dt < 12) { st.recentSpeed = 0; emit(); return; }

    st.dist += d;
    st.path.push(p);
    st.recentSpeed = v;
    if (v >= MOVING_MIN) st.movingSec += dt;

    // 1 km splits
    while (st.dist - st.lastSplitDist >= 1000) {
      st.lastSplitDist += 1000;
      const sec = st.movingSec - st.lastSplitSec;
      st.lastSplitSec = st.movingSec;
      st.splits.push({ km: st.splits.length + 1, sec });
      if (navigator.vibrate) try { navigator.vibrate([90, 60, 90]); } catch (e) { }
    }
    persist();
    emit();
  }

  function onErr(err) {
    if (err.code === 1) U.toast('位置情報が許可されていません。Safariの設定から許可してください。', true);
    else if (err.code === 3) { /* timeout — keep watching */ }
    else U.toast('GPSを取得できません（' + err.message + '）', true);
  }

  let persistAt = 0;
  function persist() {
    if (!st) return;
    const now = Date.now();
    if (now - persistAt < 4000) return;
    persistAt = now;
    try { localStorage.setItem(LIVE_KEY, JSON.stringify(st)); } catch (e) { }
  }
  function clearPersist() { try { localStorage.removeItem(LIVE_KEY); } catch (e) { } }

  /** a run that was interrupted (reload / crash) and can be resumed */
  function pending() {
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || !v.start || Date.now() - v.start > 12 * 3600e3) { clearPersist(); return null; }
      return v;
    } catch (e) { return null; }
  }

  function startWatch() {
    if (watchId != null) return;
    if (!navigator.geolocation) { U.toast('この端末では位置情報が使えません', true); return; }
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000
    });
  }
  function stopWatch() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function tick() {
    if (!st || st.paused) return;
    st.elapsedSec = (Date.now() - st.start) / 1000 - (st.pausedSec || 0);
    emit();
  }

  /* ---------- public ---------- */

  async function start(plan, course) {
    st = blank(plan, course);
    st.pausedSec = 0;
    startWatch();
    await lockScreen();
    clearInterval(ticker); ticker = setInterval(tick, 500);
    emit();
    return st;
  }

  function resumeFrom(saved) {
    st = saved;
    st.paused = false;
    st.pausedAt = null;
    startWatch();
    lockScreen();
    clearInterval(ticker); ticker = setInterval(tick, 500);
    emit();
    return st;
  }

  function pause() {
    if (!st || st.paused) return;
    st.paused = true;
    st.pausedAt = Date.now();
    stopWatch();
    releaseScreen();
    persistAt = 0; persist();
    emit();
  }

  function resume() {
    if (!st || !st.paused) return;
    st.pausedSec = (st.pausedSec || 0) + (Date.now() - st.pausedAt) / 1000;
    st.paused = false;
    st.pausedAt = null;
    startWatch();
    lockScreen();
    emit();
  }

  function stop() {
    if (!st) return null;
    stopWatch(); releaseScreen();
    clearInterval(ticker); ticker = null;
    st.end = Date.now();
    st.elapsedSec = (st.end - st.start) / 1000 - (st.pausedSec || 0);
    // if GPS was poor, moving time can undershoot badly — fall back to elapsed
    if (st.movingSec < st.elapsedSec * 0.5) st.movingSec = st.elapsedSec;
    const done = st;
    st = null;
    clearPersist();
    emit();
    if (done.dist < 50) return null;             // nothing meaningful recorded
    return RN.store.addRun({
      id: done.id, start: done.start, end: done.end,
      dist: Math.round(done.dist), movingSec: Math.round(done.movingSec),
      elapsedSec: Math.round(done.elapsedSec),
      splits: done.splits, path: done.path, plan: done.plan
    });
  }

  function discard() {
    stopWatch(); releaseScreen();
    clearInterval(ticker); ticker = null;
    st = null; clearPersist(); emit();
  }

  function snapshot() {
    if (!st) return null;
    const paceAvg = st.dist > 30 ? st.movingSec / (st.dist / 1000) : 0;
    const last = st.path[st.path.length - 1];
    return {
      active: true, paused: st.paused,
      dist: st.dist, elapsedSec: st.elapsedSec, movingSec: st.movingSec,
      paceAvg, paceNow: st.recentSpeed > MOVING_MIN ? 1000 / st.recentSpeed : 0,
      splits: st.splits, gpsAcc: st.gpsAcc, plan: st.plan,
      points: st.path.length, path: st.path,
      pos: last ? { lat: last[0], lng: last[1] } : null
    };
  }

  /** the course being followed, if the run was started from a planned route */
  function course() { return st && st.course ? st.course : null; }
  function setCourse(route) { if (st) st.course = route; }

  const isActive = () => !!st;

  /* ---------- export ---------- */

  function toGPX(run) {
    const pts = (run.path || []).map(p =>
      `   <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FRACTAL RUN NAVI" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>${new Date(run.start).toISOString()}</time></metadata>
 <trk><name>${U.esc(U.ymdhm(run.start))} ${(run.dist / 1000).toFixed(2)}km</name><trkseg>
${pts}
 </trkseg></trk>
</gpx>`;
  }

  function toCSV(runs) {
    const head = '日付,開始時刻,距離km,タイム,平均ペース/km,経過時間,コース,GPS点数';
    const rows = runs.map(r => [
      U.ymd(r.start),
      new Date(r.start).toTimeString().slice(0, 5),
      (r.dist / 1000).toFixed(2),
      U.hms(r.movingSec),
      U.pace(r.movingSec / (r.dist / 1000)),
      U.hms(r.elapsedSec || r.movingSec),
      '"' + String((r.plan && r.plan.name) || '').replace(/"/g, '""') + '"',
      (r.path || []).length
    ].join(','));
    return '﻿' + [head].concat(rows).join('\r\n');
  }

  return {
    start, resumeFrom, pause, resume, stop, discard,
    snapshot, isActive, on, pending, toGPX, toCSV, course, setCourse
  };
})();
