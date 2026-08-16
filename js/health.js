/* ================= FRACTAL RUN NAVI :: health =================
   Apple ヘルスケア連携.

   iOS gives no web API for HealthKit, so the bridge is the official export:
     ヘルスケア → プロフィール → すべてのヘルスケアデータを書き出す
   which produces export.xml. That file is routinely 100-500 MB, so it is read
   in slices and scanned with a carry-over buffer rather than parsed into a DOM.

   Two <Workout> layouts exist in the wild and both are handled:
     iOS 14-  : totalDistance / totalDistanceUnit as attributes
     iOS 15+  : <WorkoutStatistics type="...DistanceWalkingRunning" sum unit/>
   ============================================================== */
window.RN = window.RN || {};

RN.health = (function () {
  const U = RN.util;
  const CHUNK = 6 * 1024 * 1024;

  const RUN_TYPES = /Running|Jog/i;

  /** Apple writes "2024-01-01 07:00:00 +0900"; Safari will not parse that. */
  function appleDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2}):?(\d{2})/.exec(s);
    if (m) {
      const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      const off = (+m[8] * 60 + +m[9]) * 60000 * (m[7] === '-' ? -1 : 1);
      return utc - off;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function toMeters(v, unit) {
    const n = parseFloat(v);
    if (!isFinite(n)) return 0;
    switch (String(unit || '').toLowerCase()) {
      case 'km': return n * 1000;
      case 'm': return n;
      case 'mi': return n * 1609.344;
      case 'ft': return n * 0.3048;
      case 'yd': return n * 0.9144;
      default: return n * 1000;               // Apple defaults to km in JP locale
    }
  }
  function toSeconds(v, unit) {
    const n = parseFloat(v);
    if (!isFinite(n)) return 0;
    switch (String(unit || '').toLowerCase()) {
      case 'sec': case 's': return n;
      case 'hr': case 'h': return n * 3600;
      case 'min': default: return n * 60;
    }
  }

  const attr = (block, name) => {
    const m = new RegExp(name + '="([^"]*)"').exec(block);
    return m ? m[1] : null;
  };

  function parseWorkoutBlock(block) {
    const type = attr(block, 'workoutActivityType') || '';
    if (!RUN_TYPES.test(type)) return null;

    const start = appleDate(attr(block, 'startDate'));
    if (!start) return null;

    let sec = toSeconds(attr(block, 'duration'), attr(block, 'durationUnit'));
    if (!sec) {
      const end = appleDate(attr(block, 'endDate'));
      if (end) sec = (end - start) / 1000;
    }

    let dist = 0;
    const td = attr(block, 'totalDistance');
    if (td) dist = toMeters(td, attr(block, 'totalDistanceUnit'));
    if (!dist) {
      const re = /<WorkoutStatistics\b[^>]*type="HKQuantityTypeIdentifierDistanceWalkingRunning"[^>]*>/g;
      let m;
      while ((m = re.exec(block))) {
        const s = attr(m[0], 'sum');
        if (s) { dist = Math.max(dist, toMeters(s, attr(m[0], 'unit'))); }
      }
    }
    if (!dist || !sec) return null;
    return { start, dist: Math.round(dist), sec: Math.round(sec), src: attr(block, 'sourceName') || '' };
  }

  /** scan a big export.xml without building a DOM */
  async function parseXML(file, onProgress) {
    const out = [];
    let buf = '';
    let seenWorkoutTag = false;

    for (let off = 0; off < file.size; off += CHUNK) {
      buf += await file.slice(off, Math.min(file.size, off + CHUNK)).text();

      for (;;) {
        const i = buf.indexOf('<Workout ');
        if (i < 0) {
          // nothing pending — keep only a small tail in case a tag straddles chunks
          buf = buf.slice(Math.max(0, buf.length - 32));
          break;
        }
        seenWorkoutTag = true;
        const gt = buf.indexOf('>', i);
        if (gt < 0) { buf = buf.slice(i); break; }        // need more data

        let block, next;
        if (buf[gt - 1] === '/') {                        // <Workout ... />
          block = buf.slice(i, gt + 1); next = gt + 1;
        } else {
          const close = buf.indexOf('</Workout>', gt);
          if (close < 0) {
            if (buf.length - i > 4 * 1024 * 1024) { buf = buf.slice(gt + 1); continue; } // pathological
            buf = buf.slice(i); break;                    // need more data
          }
          block = buf.slice(i, close + 10); next = close + 10;
        }
        const w = parseWorkoutBlock(block);
        if (w) out.push(w);
        buf = buf.slice(next);
      }
      if (onProgress) onProgress(Math.min(1, (off + CHUNK) / file.size), out.length);
    }
    return { workouts: out, seenWorkoutTag };
  }

  /** flexible CSV: Shortcuts / RunGap / HealthFit exports, or a hand-made sheet */
  function parseCSV(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { workouts: [] };
    const split = l => {
      const out = []; let cur = '', q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur); return out;
    };
    const head = split(lines[0]).map(h => h.trim().toLowerCase());
    const find = pats => head.findIndex(h => pats.some(p => h.includes(p)));
    const iDate = find(['日付', '開始', 'date', 'start']);
    const iDist = find(['距離', 'distance', 'km']);
    const iTime = find(['タイム', '時間', 'duration', 'time', 'elapsed', 'moving']);
    if (iDate < 0 || iDist < 0 || iTime < 0) return { workouts: [], badHeader: head };

    const dur = s => {
      s = String(s).trim();
      if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 60;      // bare number = minutes
      const p = s.split(':').map(Number);
      if (p.some(isNaN)) return 0;
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
    };
    const workouts = [];
    for (let i = 1; i < lines.length; i++) {
      const c = split(lines[i]);
      const t = appleDate(c[iDate]) || Date.parse(String(c[iDate]).replace(/\//g, '-'));
      const km = parseFloat(String(c[iDist]).replace(/[^\d.]/g, ''));
      const sec = dur(c[iTime]);
      if (!t || isNaN(t) || !km || !sec) continue;
      workouts.push({ start: t, dist: Math.round(km * 1000), sec: Math.round(sec), src: 'CSV' });
    }
    return { workouts };
  }

  /** entry point for the file picker */
  async function importFile(file, onProgress) {
    const name = (file.name || '').toLowerCase();
    let res;
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      res = parseCSV(await file.text());
      if (res.badHeader) throw new Error('CSVの列が読み取れませんでした（日付・距離・タイムの列が必要です）');
    } else if (name.endsWith('.zip')) {
      throw new Error('zipのままでは読み込めません。解凍して中の export.xml を選んでください。');
    } else {
      res = await parseXML(file, onProgress);
      if (!res.workouts.length && !res.seenWorkoutTag)
        throw new Error('ワークアウトが見つかりません。ヘルスケアの「すべてのヘルスケアデータを書き出す」で作られた export.xml を選んでください。');
    }

    // dedupe by start time, sanity-filter, keep newest 400
    const seen = new Set();
    const workouts = res.workouts
      .filter(w => {
        if (w.dist < 400 || w.sec < 120) return false;
        const pace = w.sec / (w.dist / 1000);
        if (pace < 140 || pace > 1500) return false;      // 2:20–25:00 /km
        const k = Math.round(w.start / 60000);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      })
      .sort((a, b) => b.start - a.start)
      .slice(0, 400);

    if (!workouts.length) throw new Error('ランニングのワークアウトが見つかりませんでした。');

    const h = {
      importedAt: Date.now(),
      count: workouts.length,
      fileName: file.name,
      workouts
    };
    RN.store.setHealth(h);
    return h;
  }

  /** summary for the settings screen */
  function summary() {
    const h = RN.store.health();
    if (!h || !h.workouts || !h.workouts.length) return null;
    const w = h.workouts;
    const total = w.reduce((a, x) => a + x.dist, 0);
    const recent = w.slice(0, 10);
    const pace = recent.reduce((a, x) => a + x.sec / (x.dist / 1000), 0) / recent.length;
    return {
      count: w.length, total, importedAt: h.importedAt, fileName: h.fileName,
      from: w[w.length - 1].start, to: w[0].start, recentPace: pace
    };
  }

  return { importFile, parseCSV, parseXML, summary, appleDate };
})();
