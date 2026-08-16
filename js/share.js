/* ================= FRACTAL RUN NAVI :: share =================
   Turn a run (or a planned course) into something postable.

   Text is the primary output: three styles, editable before copying, because
   nobody posts a canned string verbatim. The route card is drawn from the
   polyline alone — no map tiles — so it works offline and can never be
   canvas-tainted by a cross-origin tile.
   ============================================================== */
window.RN = window.RN || {};

RN.share = (function () {
  const U = RN.util;

  /* ---------------- normalise both shapes into one ---------------- */

  /** @param src a recorded run (has .dist/.movingSec/.path[[lat,lng]]) or a planned route */
  function digest(src) {
    const isRun = src.dist != null && src.movingSec != null;
    const dist = isRun ? src.dist : src.distance;
    const sec = isRun ? src.movingSec : null;
    const pace = sec && dist ? sec / (dist / 1000) : null;

    let names = [];
    if (src.plan && src.plan.name) names = src.plan.name.split(' → ');
    else if (src.stops) names = src.stops.filter(s => !s.ghost).map(s => s.name);

    const line = isRun
      ? (src.path || []).map(p => ({ lat: p[0], lng: p[1] }))
      : (src.path || []);

    return {
      isRun, dist, sec, pace,
      at: isRun ? src.start : (src.savedAt || null),
      names,
      origin: (src.origin && src.origin.label) || null,
      mode: src.modeLabel || (src.plan && src.plan.mode) || null,
      elev: src.elev || null,
      splits: src.splits || [],
      line
    };
  }

  const km1 = m => (m / 1000).toFixed(2);

  function timeOfDayWord(ts) {
    if (!ts) return 'ラン';
    const h = new Date(ts).getHours();
    if (h < 5) return 'ナイトラン';
    if (h < 10) return '朝ラン';
    if (h < 16) return '昼ラン';
    if (h < 19) return '夕ラン';
    return 'ナイトラン';
  }

  function courseLine(d, withOrigin) {
    const parts = [];
    if (withOrigin && d.origin) parts.push(d.origin);
    parts.push(...d.names);
    if (withOrigin && d.origin && d.mode !== '片道') parts.push(d.origin);
    return parts.join(' → ');
  }

  /* ---------------- the three text styles ---------------- */

  function standard(d, tags) {
    const L = [];
    L.push(`${timeOfDayWord(d.at)} 🏃`);
    L.push(`${km1(d.dist)}km` + (d.sec ? `／${U.hms(d.sec)}／平均 ${U.pace(d.pace)}/km` : ''));
    if (d.elev) L.push(`獲得標高 ↑${d.elev.gain}m（${d.elev.label.text}）`);
    const c = courseLine(d, true);
    if (c) L.push(`コース：${c}`);
    if (d.at) L.push(U.ymdhm(d.at));
    if (tags) L.push('', tags);
    return L.join('\n');
  }

  function short(d, tags) {
    const c = d.names.slice(0, 2).join('→');
    let s = `${km1(d.dist)}km`;
    if (d.sec) s += ` ${U.hms(d.sec)}（${U.pace(d.pace)}/km）`;
    if (c) s += ` ${c}を回るコース`;
    s += ' 🏃';
    if (tags) s += ' ' + tags;
    // X counts most CJK characters as two; keep well inside a single post
    return s;
  }

  function detailed(d, tags) {
    /* SNS renders posts in a proportional font, so ASCII spaces cannot align a
       column of Japanese labels. Ideographic spaces (U+3000) are the same width
       as the kanji beside them, which is the only padding that actually lines
       up once posted. */
    const label = s => s + '　'.repeat(Math.max(0, 4 - Array.from(s).length)) + '　';
    const L = [];
    L.push(`${d.at ? U.ymd(d.at) + ' ' : ''}${timeOfDayWord(d.at)}`);
    L.push('━━━━━━━━━━━━');
    L.push(`${label('距離')}${km1(d.dist)} km`);
    if (d.sec) {
      L.push(`${label('タイム')}${U.hms(d.sec)}`);
      L.push(`${label('ペース')}${U.pace(d.pace)} /km`);
    }
    if (d.elev) L.push(`${label('獲得標高')}↑${d.elev.gain} m（最大勾配 ${d.elev.maxGrade}%）`);
    const c = courseLine(d, true);
    if (c) L.push(`${label('コース')}${c}`);
    if (d.splits.length) {
      L.push('', '▸ スプリット');
      const wide = d.splits.length >= 10;
      d.splits.forEach(s => {
        const k = String(s.km) + 'km';
        L.push('　' + k + ' '.repeat(Math.max(1, (wide ? 5 : 4) - k.length)) + U.pace(s.sec));
      });
      const best = d.splits.reduce((a, b) => (b.sec < a.sec ? b : a));
      L.push(`　ベスト ${best.km}km目 ${U.pace(best.sec)}`);
    }
    if (tags) L.push('', tags);
    return L.join('\n');
  }

  const STYLES = {
    standard: { label: '標準', build: standard },
    short: { label: 'X向け（短め）', build: short },
    detailed: { label: '詳細（スプリット入り）', build: detailed }
  };

  function build(src, style, tags) {
    const d = digest(src);
    return (STYLES[style] || STYLES.standard).build(d, (tags || '').trim());
  }

  /* ---------------- clipboard ----------------
     iOS Safari only honours navigator.clipboard.writeText when it is reached
     synchronously from the user gesture, so this must never be awaited behind
     anything else. execCommand is kept as the fallback for older WebKit.     */
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /* ---------------- route card ----------------
     Equirectangular projection with a cos(lat) correction is exact enough at
     city scale and keeps the shape honest; the card is square so it drops into
     Instagram and X alike.                                                   */

  function project(line, w, h, pad) {
    if (!line.length) return [];
    const lats = line.map(p => p.lat), lngs = line.map(p => p.lng);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats);
    const minLo = Math.min(...lngs), maxLo = Math.max(...lngs);
    const midLa = (minLa + maxLa) / 2;
    const kx = Math.cos(midLa * Math.PI / 180);
    const spanX = Math.max(1e-9, (maxLo - minLo) * kx);
    const spanY = Math.max(1e-9, maxLa - minLa);
    const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const offX = (w - spanX * s) / 2, offY = (h - spanY * s) / 2;
    return line.map(p => [
      offX + (p.lng - minLo) * kx * s,
      h - (offY + (p.lat - minLa) * s)              // canvas y grows downward
    ]);
  }

  function card(src, opts) {
    const d = digest(src);
    const S = (opts && opts.size) || 1080;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');

    const grad = g.createLinearGradient(0, 0, S, S);
    grad.addColorStop(0, '#121b26');
    grad.addColorStop(1, '#080c11');
    g.fillStyle = grad; g.fillRect(0, 0, S, S);

    // route — the hero of the card, so give it most of the upper area
    const pts = project(d.line, S, S * 0.70, S * 0.11);
    if (pts.length > 1) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = S * 0.030;
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();

      const rg = g.createLinearGradient(0, 0, S, S * 0.66);
      rg.addColorStop(0, '#00e5a0'); rg.addColorStop(1, '#0bd0ff');
      g.strokeStyle = rg; g.lineWidth = S * 0.017;
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();

      const dot = (p, col, r) => {
        g.beginPath(); g.arc(p[0], p[1], r, 0, Math.PI * 2);
        g.fillStyle = '#080c11'; g.fill();
        g.beginPath(); g.arc(p[0], p[1], r * 0.66, 0, Math.PI * 2);
        g.fillStyle = col; g.fill();
      };
      dot(pts[0], '#00e5a0', S * 0.020);
      dot(pts[pts.length - 1], '#ffb020', S * 0.020);
    }

    const F = (px, weight) => `${weight || 700} ${Math.round(px)}px -apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif`;
    const y0 = S * 0.675;

    g.textAlign = 'left';
    g.fillStyle = '#5d708a'; g.font = F(S * 0.026, 700);
    g.fillText(`${d.at ? U.ymd(d.at) + '  ' : ''}${timeOfDayWord(d.at)}`, S * 0.09, y0);

    // headline number
    g.fillStyle = '#eaf0f7'; g.font = F(S * 0.135, 800);
    const kmTxt = km1(d.dist);
    g.fillText(kmTxt, S * 0.09, y0 + S * 0.115);
    const kw = g.measureText(kmTxt).width;
    g.fillStyle = '#8fa2b8'; g.font = F(S * 0.042, 700);
    g.fillText('km', S * 0.09 + kw + S * 0.016, y0 + S * 0.115);

    // secondary stats
    const stats = [];
    if (d.sec) stats.push(['タイム', U.hms(d.sec)]);
    if (d.pace) stats.push(['ペース', U.pace(d.pace) + ' /km']);
    if (d.elev) stats.push(['獲得標高', '↑' + d.elev.gain + ' m']);
    let sx = S * 0.09;
    stats.forEach(([k, v]) => {
      g.fillStyle = '#5d708a'; g.font = F(S * 0.023, 700);
      g.fillText(k, sx, y0 + S * 0.163);
      g.fillStyle = '#00e5a0'; g.font = F(S * 0.045, 800);
      g.fillText(v, sx, y0 + S * 0.213);
      sx += Math.max(g.measureText(v).width, S * 0.16) + S * 0.055;
    });

    // course line, truncated to fit on one line
    const c = courseLine(d, true);
    if (c) {
      g.fillStyle = '#8fa2b8'; g.font = F(S * 0.026, 600);
      let t = c;
      while (g.measureText(t).width > S * 0.82 && t.length > 8) t = t.slice(0, -2);
      if (t !== c) t = t.replace(/\s*→?\s*$/, '') + ' …';
      g.fillText(t, S * 0.09, y0 + S * 0.252);
    }

    // sits below the course line with room to spare — the two used to collide
    g.fillStyle = '#3d4c60'; g.font = F(S * 0.021, 700);
    g.fillText('FRACTAL RUN NAVI', S * 0.09, S * 0.972);

    return cv;
  }

  function cardBlob(src, opts) {
    return new Promise(res => card(src, opts).toBlob(b => res(b), 'image/png', 0.95));
  }

  return { build, digest, copy, card, cardBlob, STYLES };
})();
