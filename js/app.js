/* ================= FRACTAL RUN NAVI :: app ================= */
(function () {
  const U = RN.util, S = RN.store, P = RN.planner, PV = RN.providers;
  const $ = U.$, $$ = U.$$;

  const state = {
    origin: null,          // {label, lat, lng}
    candidates: [],
    km: S.settings.get('lastKm') || 5,
    mode: S.settings.get('lastMode') || 'loop',
    cat: S.settings.get('lastCat') || 'any',
    hills: S.settings.get('hills') || 'any',
    results: [],
    route: null,
    searching: null,       // {aborted}
    seenStops: new Set()   // for 「別のコースを探す」
  };

  /* =============== view switching =============== */
  const VIEWS = ['route', 'detail', 'run', 'log', 'settings'];
  function show(name) {
    VIEWS.forEach(v => { const n = $('#view-' + v); if (n) n.hidden = (v !== name); });
    $$('#tabbar .tab').forEach(t => t.classList.toggle('is-on', t.dataset.tab === name));
    if (name === 'detail') RN.mapview.invalidate('map');
    if (name === 'log') renderLog();
    if (name === 'run') { renderRun(RN.tracker.snapshot()); RN.mapview.invalidate('runmap'); }
    window.scrollTo(0, 0);
  }
  $$('#tabbar .tab').forEach(t => t.onclick = () => show(t.dataset.tab));
  $('#btn-go-settings').onclick = () => show('settings');
  $('#btn-detail-back').onclick = () => show('route');

  /* =============== engine =============== */
  function engineId() {
    const e = S.settings.get('engine');
    return (e === 'google' && S.settings.get('gkey')) ? 'google' : 'osm';
  }
  function provider() { return PV.get(engineId()); }

  function paintEngineNote() {
    const g = engineId() === 'google';
    $('#engine-note').innerHTML = g
      ? 'データ元：Google マップ（クチコミ件数・評価）／ ルート：Google Directions'
      : 'データ元：OpenStreetMap ＋ Wikipedia閲覧数（人気の代替指標）／ ルート：FOSSGIS OSRM<br>'
      + '<b>Googleのクチコミ件数で選びたい場合は、設定でAPIキーを登録してください。</b>';
    $('#foot-src').textContent = provider().attribution;
  }

  /* =============== 出発地 =============== */
  const inOrigin = $('#in-origin');

  function renderOriginHistory() {
    const box = $('#origin-history');
    box.innerHTML = '';
    S.origins().forEach(o => {
      const b = U.el('button', 'chip chip-sm', o.label);
      b.onclick = () => {
        inOrigin.value = o.label;
        state.origin = { label: o.label, lat: o.lat, lng: o.lng };
        state.candidates = [];
        $('#origin-status').textContent = '📍 ' + o.label;
        renderOriginHistory();
      };
      box.appendChild(b);
    });
  }

  function renderCandidates() {
    if (state.candidates.length < 2) return;
    const box = $('#origin-history');
    box.innerHTML = '';
    state.candidates.slice(0, 4).forEach(c => {
      const on = state.origin && Math.abs(c.lat - state.origin.lat) < 1e-6;
      const b = U.el('button', 'chip chip-sm' + (on ? ' is-on' : ''), c.label);
      b.title = c.detail || '';
      b.onclick = () => {
        state.origin = { label: c.label, lat: c.lat, lng: c.lng };
        $('#origin-status').textContent = '📍 ' + (c.detail || c.label);
        renderCandidates();
      };
      box.appendChild(b);
    });
  }

  async function resolveOrigin(force) {
    const q = inOrigin.value.trim();
    if (!q) { U.toast('出発地を入力してください', true); inOrigin.focus(); return null; }
    if (!force && state.origin && state.origin.label === q) return state.origin;

    $('#origin-status').textContent = '住所を検索中…';
    try {
      const res = await provider().geocode(q);
      if (!res.length) { $('#origin-status').textContent = '見つかりませんでした'; U.toast('その住所は見つかりませんでした', true); return null; }
      // geocoders happily return the station building and the station node as
      // two hits — identical chips help nobody
      state.candidates = res.filter((c, i) =>
        !res.slice(0, i).some(p => p.label === c.label && U.haversine(p, c) < 250));
      state.origin = { label: res[0].label, lat: res[0].lat, lng: res[0].lng };
      $('#origin-status').textContent = '📍 ' + (res[0].detail || res[0].label);
      renderCandidates();
      return state.origin;
    } catch (e) {
      $('#origin-status').textContent = '検索に失敗しました';
      U.toast('住所検索に失敗しました：' + e.message, true);
      return null;
    }
  }

  inOrigin.addEventListener('change', () => { state.origin = null; });
  inOrigin.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inOrigin.blur(); resolveOrigin(true); }
  });

  $('#btn-locate').onclick = () => {
    if (!navigator.geolocation) return U.toast('位置情報が使えません', true);
    $('#origin-status').textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(async pos => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const label = await provider().reverse(p).catch(() => '現在地');
      state.origin = { label, lat: p.lat, lng: p.lng };
      state.candidates = [];
      inOrigin.value = label;
      $('#origin-status').textContent = `📍 ${label}（現在地・誤差${Math.round(pos.coords.accuracy)}m）`;
      renderOriginHistory();
    }, err => {
      $('#origin-status').textContent = '現在地を取得できませんでした';
      U.toast(err.code === 1 ? '位置情報が許可されていません' : '現在地を取得できません', true);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  };

  /* =============== 距離 / モード / カテゴリ =============== */
  const slider = $('#in-dist'), out = $('#out-dist');
  const distChips = $$('#dist-chips .chip').concat($$('#dist-chips2 .chip'));
  function setKm(km, fromSlider) {
    state.km = km;
    S.settings.set('lastKm', km);
    out.textContent = km.toFixed(1) + ' km';
    if (!fromSlider) slider.value = km;
    distChips.forEach(c => c.classList.toggle('is-on', Math.abs(+c.dataset.km - km) < 0.05));
  }
  distChips.forEach(c => c.onclick = () => setKm(+c.dataset.km));
  slider.oninput = () => setKm(+slider.value, true);

  $$('#seg-mode .seg-btn').forEach(b => b.onclick = () => {
    state.mode = b.dataset.mode;
    S.settings.set('lastMode', state.mode);
    $$('#seg-mode .seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
  });
  $$('#cat-chips .chip').forEach(b => b.onclick = () => {
    state.cat = b.dataset.cat;
    S.settings.set('lastCat', state.cat);
    $$('#cat-chips .chip').forEach(x => x.classList.toggle('is-on', x === b));
    paintCatHint();
  });
  $$('#hill-chips .chip').forEach(b => b.onclick = () => {
    state.hills = b.dataset.hills;
    S.settings.set('hills', state.hills);
    $$('#hill-chips .chip').forEach(x => x.classList.toggle('is-on', x === b));
    // re-rank what is already on screen instead of making the user search again
    if (state.results.length) {
      P.applyHillPreference(state.results, state.hills, state.km * 1000);
      state.results.forEach((r, i) => r.rank = i + 1);
      renderResults(state.results);
    }
  });

  function paintCatHint() {
    const g = engineId() === 'google';
    $('#cat-hint').innerHTML = g
      ? 'Googleの<b>クチコミ件数</b>が多い順に優先して経由します。'
      : state.cat === 'food'
        ? '⚠︎ オープンデータには飲食店の人気度がありません。カフェ・飲食で選ぶなら<b>設定でGoogle APIキー</b>の登録をおすすめします。'
        : '<b>Wikipediaの月間閲覧数</b>と<b>公園などの面積</b>から人気度を推定して経由します。';
  }

  /* =============== 検索 =============== */
  const btnSearch = $('#btn-search');

  let lastProgress = { frac: 0, text: '検索中…' };
  function progress(frac, text) {
    $('#search-progress').classList.remove('hidden');
    $('#progress-fill').style.width = Math.round(frac * 100) + '%';
    if (text) lastProgress = { frac, text };
    text = text || lastProgress.text;
    let note = '';
    if (engineId() === 'osm') {
      const gap = PV.osmThrottled();
      note = gap
        // otherwise a backoff wait is indistinguishable from a hang
        ? `<span style="color:var(--warn)">共有サーバーが混雑しています。${gap}秒間隔まで落として順番待ち中…</span>`
        : '<span style="opacity:.6">（オープンデータの共有サーバー利用のため20〜40秒かかります）</span>';
    }
    $('#progress-text').innerHTML = U.esc(text) + (note ? '<br>' + note : '');
  }
  // throttling can begin mid-search, so refresh the notice on a timer too
  setInterval(() => { if (state.searching) progress(lastProgress.frac); }, 3000);

  async function runSearch(reroll) {
    if (state.searching) { state.searching.aborted = true; return; }
    const origin = await resolveOrigin(false);
    if (!origin) return;

    S.addOrigin(origin);
    renderOriginHistory();
    if (state.candidates.length > 1) renderCandidates();
    loadWeather(origin);

    if (!reroll) state.seenStops = new Set();

    const sig = { aborted: false };
    state.searching = sig;
    btnSearch.querySelector('.btn-label').textContent = '中止する';
    $('#btn-reroll').classList.add('hidden');
    $('#results').innerHTML = '';
    state.results = [];
    progress(0.02, '準備中…');

    try {
      if (engineId() === 'google') await PV.google.init();
      const routes = await P.plan({
        provider: provider(),
        origin,
        targetMeters: state.km * 1000,
        mode: state.mode,
        category: state.cat,
        hills: state.hills,
        exclude: state.seenStops,
        onProgress: progress,
        // show the first course the moment it exists rather than after the
        // whole search — most of the wait is the routes we end up discarding
        onPartial: rs => { state.results = rs; renderResults(rs, true); },
        signal: sig
      });
      state.results = routes;
      routes.forEach(r => r.stops.forEach(s => { if (!s.ghost) state.seenStops.add(s.id); }));
      renderResults(routes);
      $('#btn-reroll').classList.toggle('hidden', !routes.length);
      if (!routes.length) U.toast('条件に合うコースが見つかりませんでした', true);
    } catch (e) {
      if (String(e.message) === 'ABORT') U.toast('検索を中止しました');
      else {
        console.error(e);
        U.toast(e.message || '検索に失敗しました', true);
        // the open-data servers fail transiently; make retrying one tap
        const box = $('#results');
        box.innerHTML = '';
        const card = U.el('div', 'card');
        card.innerHTML = `<div class="hint hint-block">${U.esc(e.message || '検索に失敗しました')}</div>`;
        const btn = U.el('button', 'btn-ghost wide', 'もう一度試す');
        btn.onclick = () => runSearch(false);
        card.appendChild(btn);
        box.appendChild(card);
      }
      if (state.results.length) $('#btn-reroll').classList.remove('hidden');
    } finally {
      state.searching = null;
      btnSearch.querySelector('.btn-label').textContent = 'コースを探す';
      $('#search-progress').classList.add('hidden');
    }
  }

  btnSearch.onclick = () => runSearch(false);
  $('#btn-reroll').onclick = () => runSearch(true);

  /* =============== 天気 =============== */
  async function loadWeather(origin) {
    const box = $('#wx');
    try {
      const w = await RN.weather.get(origin);
      const lv = (w.advice && w.advice.level) || 0;
      box.className = 'wx lv' + lv;
      box.hidden = false;
      box.innerHTML = `
        <div class="wx-ico">${w.icon}</div>
        <div class="wx-body">
          <div class="wx-main">${U.esc(w.desc)} ${w.temp != null ? w.temp.toFixed(1) + '℃' : ''}
            <small>体感 ${w.apparent != null ? w.apparent.toFixed(1) + '℃' : '–'}
            ・湿度 ${w.humidity != null ? w.humidity + '%' : '–'}
            ・風 ${w.wind != null ? w.wind.toFixed(0) + 'km/h' : '–'}</small></div>
          <div class="wx-sub">${w.advice ? U.esc(w.advice.text) : ''}${w.popNext3h != null
          ? `　／　3時間以内の降水確率 ${w.popNext3h}%` : ''}</div>
        </div>`;
    } catch (e) { box.hidden = true; }
  }

  /* =============== 結果 =============== */
  function etaSec(meters) {
    const pm = S.paceModel(meters);
    return { sec: (meters / 1000) * pm.sec, model: pm };
  }

  function renderResults(routes, provisional) {
    const box = $('#results');
    box.innerHTML = '';
    if (!routes.length) return;

    const h = U.el('div', 'field-label',
      provisional
        ? `${routes.length}件見つかりました（さらに探索中…）`
        : `${routes.length}件のコース（${state.km}km ${P.MODE_LABEL[state.mode]}）`);
    h.style.margin = '4px 2px 8px';
    box.appendChild(h);

    routes.forEach(r => {
      const eta = etaSec(r.distance);
      const real = r.stops.filter(s => !s.ghost);
      const errPct = Math.round(r.err * 100);
      const title = real.length
        ? U.esc(real[0].name) + (real.length > 1 ? ` ほか${real.length - 1}ヶ所` : '')
        : `${U.esc(r.modeLabel)}コース（周辺に目立つスポットなし）`;

      const card = U.el('div', 'res');
      card.innerHTML = `
        <div class="res-top">
          <div class="res-rank">${r.rank}</div>
          <div class="res-head">
            <div class="res-name">${title}</div>
            <div class="res-meta">${U.esc(r.modeLabel)}・目標${(r.target / 1000).toFixed(1)}kmとの差 ${errPct <= 2 ? 'ほぼぴったり' : (r.distance > r.target ? '+' : '−') + Math.abs(r.distance - r.target).toFixed(0) + 'm'}</div>
          </div>
        </div>
        <div class="res-nums">
          <div class="v-good"><b>${U.km(r.distance)}</b><em>km</em></div>
          <div><b>${U.hms(eta.sec)}</b><em>予想タイム</em></div>
          <div><b>${r.elev ? '↑' + r.elev.gain + 'm' : '–'}</b><em>獲得標高</em></div>
        </div>
        <div class="res-stops"></div>
        ${r.elev ? `<div class="elev">
          <div class="elev-chart">${RN.terrain.sparkline(r.elev, 300, 40)}</div>
          <div class="elev-num"><b>${U.esc(r.elev.label.text)}</b><em>最大勾配 ${r.elev.maxGrade}%</em></div>
        </div>` : ''}`;

      const stopsBox = card.querySelector('.res-stops');
      r.stops.forEach(s => {
        const chip = U.el('span', 'stop');
        const badge = s.reviews != null ? `${U.nfmt(s.reviews)}件`
          : s.views ? `${U.nfmt(s.views)}/月`
            : s.area > 20000 ? `${(s.area / 10000).toFixed(0)}ha` : '';
        chip.innerHTML = `${PV.iconFor(s)} <b>${U.esc(s.name)}</b>${badge ? ` <i>${badge}</i>` : ''}`;
        stopsBox.appendChild(chip);
      });

      card.onclick = () => openDetail(r);
      box.appendChild(card);
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* =============== 詳細 =============== */
  function paintStar(r) {
    const b = $('#btn-star');
    b.hidden = !r;
    if (!r) return;
    const on = S.isSaved(r.id);
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
    b.onclick = () => {
      const nowOn = S.toggleSave(r);
      paintStar(r);
      U.toast(nowOn ? 'コースを保存しました（履歴タブに表示されます）' : '保存を解除しました');
    };
  }

  function openDetail(r) {
    state.route = r;
    show('detail');
    $('#detail-title').textContent = `${(r.distance / 1000).toFixed(2)}km ${r.modeLabel}`;
    RN.mapview.showRoute(r, 'map');
    paintStar(r);

    const eta = etaSec(r.distance);
    const sheet = $('#detail-sheet');
    sheet.innerHTML = `
      <div class="sheet-grab"></div>
      <div class="d-nums">
        <div><b>${U.km(r.distance)}</b><em>km</em></div>
        <div><b>${U.hms(eta.sec)}</b><em>予想タイム</em></div>
        <div><b>${U.pace(eta.model.sec)}</b><em>ペース /km</em></div>
      </div>
      ${r.elev ? `<div class="card" style="padding:10px 12px 4px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:12px;font-weight:700;color:var(--fg2)">高低差
            <span class="hill-tag l${r.elev.label.level}">${U.esc(r.elev.label.text)}</span></span>
          <span style="font-size:11.5px;color:var(--fg3)">獲得標高 ↑${r.elev.gain}m ／ ↓${r.elev.loss}m
            ・最大勾配 ${r.elev.maxGrade}%</span>
        </div>
        <div style="height:52px;margin-top:4px">${RN.terrain.sparkline(r.elev, 320, 52)}</div>
      </div>` : ''}
      <div class="hint" style="margin:-6px 0 12px">予想タイムの根拠：${U.esc(eta.model.src)}</div>
      <ul class="d-list" id="d-list"></ul>
      <div class="d-actions">
        <button class="btn-primary" id="btn-open-gmaps" style="margin-bottom:0">Google マップでナビを開く</button>
        <button class="btn-ghost wide" id="btn-run-this">このコースで走る（記録開始）</button>
        <button class="btn-ghost wide" id="btn-sns-course">SNS用のテキストをつくる</button>
        <button class="btn-ghost wide" id="btn-share">コースを共有 / GPX保存</button>
      </div>`;

    /* Distance to each stop is measured along the real polyline, not by adding
       up straight lines: for a loop the return leg would otherwise read as a
       decreasing distance. */
    const cum = [0];
    for (let i = 1; i < (r.path || []).length; i++) cum[i] = cum[i - 1] + U.haversine(r.path[i - 1], r.path[i]);
    let searchFrom = 0;
    function alongPath(pt) {
      if (!r.path || r.path.length < 2) return null;
      let best = searchFrom, bestD = Infinity;
      for (let i = searchFrom; i < r.path.length; i++) {
        const d = U.haversine(r.path[i], pt);
        if (d < bestD) { bestD = d; best = i; }
      }
      searchFrom = best;                  // stops are visited in order
      return cum[best];
    }

    const list = $('#d-list');
    const seq = [{ name: r.origin.label || 'スタート', icon: '🚩', sub: '出発地', d: 0 }];
    let acc = 0, prev = { lat: r.origin.lat, lng: r.origin.lng };
    r.stops.forEach(s => {
      const along = alongPath(s);
      acc = along != null ? along : acc + U.haversine(prev, s);
      prev = s;
      const badge = PV.popLabel(s);
      seq.push({
        name: s.name, icon: PV.iconFor(s), poi: s,
        sub: s.ghost ? '折り返し（目立った施設なし）'
          : [PV.kindLabel(s),
          s.rating != null ? '★' + s.rating.toFixed(1) : '',
          badge ? `<span class="rev">${badge}</span>` : ''].filter(Boolean).join('・'),
        d: acc
      });
    });
    if (r.mode !== 'one_way') {
      seq.push({ name: r.origin.label || 'ゴール', icon: '🏁', sub: '出発地に戻る', d: r.distance });
    } else if (seq.length) {
      seq[seq.length - 1].d = r.distance;
    }
    seq.forEach((x, i) => {
      const li = U.el('li');
      li.innerHTML = `<div class="d-ico">${x.icon}</div>
        <div class="d-body"><div class="d-name">${U.esc(x.name)}</div><div class="d-sub">${x.sub}</div></div>
        <div class="d-km">${i === 0 ? '' : (x.d / 1000).toFixed(1) + 'km'}</div>`;
      if (x.poi && x.poi.url) {
        li.style.cursor = 'pointer';
        li.onclick = () => window.open(x.poi.url, '_blank', 'noopener');
      }
      list.appendChild(li);
    });

    $('#btn-open-gmaps').onclick = () => {
      const url = P.mapsUrl(r);
      window.open(url, '_blank', 'noopener');
    };
    $('#btn-run-this').onclick = () => startRunWithPlan(r);
    $('#btn-sns-course').onclick = () => openShare(r);
    $('#btn-share').onclick = () => shareRoute(r);
  }

  async function shareRoute(r) {
    const url = P.mapsUrl(r);
    const text = `${(r.distance / 1000).toFixed(2)}km ${r.modeLabel}｜`
      + r.stops.filter(s => !s.ghost).map(s => s.name).join(' → ');
    if (navigator.share) {
      try { await navigator.share({ title: 'RUN NAVI コース', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    U.download(`runnavi-${(r.distance / 1000).toFixed(1)}km.gpx`, routeGPX(r), 'application/gpx+xml');
    U.toast('GPXを保存しました');
  }

  function routeGPX(r) {
    const pts = (r.path || []).map(p => `   <rtept lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`).join('\n');
    const wpts = r.stops.map(s =>
      ` <wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}"><name>${U.esc(s.name)}</name></wpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FRACTAL RUN NAVI" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
 <rte><name>${(r.distance / 1000).toFixed(2)}km ${U.esc(r.modeLabel)}</name>
${pts}
 </rte>
</gpx>`;
  }

  /* =============== 走る =============== */
  let pendingPlan = null, pendingCourse = null;
  let follow = S.settings.get('followMap') !== false;
  let offCount = 0;

  function startRunWithPlan(r) {
    if (RN.tracker.isActive()) { show('run'); return U.toast('すでに記録中です'); }
    pendingPlan = {
      routeId: r.id,
      name: r.stops.filter(s => !s.ghost).map(s => s.name).join(' → ') || r.modeLabel,
      distance: r.distance, mode: r.mode
    };
    // keep only what the live map needs — the full POI payload is not worth
    // carrying into localStorage on every autosave
    pendingCourse = {
      id: r.id, mode: r.mode, distance: r.distance, path: r.path,
      origin: r.origin, stops: r.stops.map(s => ({ lat: s.lat, lng: s.lng, name: s.name }))
    };
    show('run');
    U.toast('「スタート」を押すと記録が始まります');
    renderRun(RN.tracker.snapshot());
  }

  function activeCourse() {
    return RN.tracker.course() || pendingCourse;
  }

  function paintTarget(s) {
    const box = $('#run-target');
    const plan = (s && s.plan) || pendingPlan;
    if (!plan) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    let remain = '';
    const c = activeCourse();
    if (s && s.pos && c && c.path && c.path.length > 1) {
      const loc = P.locateOnPath(c.path, s.pos);
      if (loc) {
        const left = Math.max(0, c.distance - loc.along);
        remain = `<span class="remain">残り約 ${(left / 1000).toFixed(2)}km`
          + `（コース上 ${(loc.along / 1000).toFixed(2)}km 地点）</span>`;
      }
    }
    box.innerHTML = `🎯 <b>${(plan.distance / 1000).toFixed(2)}km</b>　${U.esc(plan.name)}${remain}`;
  }

  /* live map: the planned course is painted once, the breadcrumb every fix */
  function paintRunMap(s) {
    const c = activeCourse();
    const wrap = $('#run-map-wrap');
    const showMap = !!(c || (s && s.path && s.path.length));
    const wasHidden = wrap.hidden;
    wrap.hidden = !showMap;
    $('#view-run').classList.toggle('has-map', showMap);
    if (!showMap) return;

    RN.mapview.ensure('runmap');
    // only when the container just gained size — this runs on every GPS fix
    if (wasHidden) RN.mapview.invalidate('runmap');
    RN.mapview.liveSetRoute(c || null, 'runmap');

    if (s && s.path && s.path.length) {
      RN.mapview.liveUpdate('runmap', s.path, { follow });
      // off-route warning, but only after a few consecutive bad fixes so a
      // single wild GPS reading does not nag mid-run
      if (c && c.path && c.path.length > 1 && s.pos) {
        const loc = P.locateOnPath(c.path, s.pos);
        offCount = (loc && loc.offRoute > 90) ? offCount + 1 : 0;
        $('#offroute').classList.toggle('hidden', offCount < 3);
      } else $('#offroute').classList.add('hidden');
    } else if (c) {
      $('#offroute').classList.add('hidden');
    }
  }

  function renderRun(s) {
    const badge = $('#gps-badge');
    if (s) {
      $('#run-km').textContent = (s.dist / 1000).toFixed(2);
      $('#run-time').textContent = U.hms(s.elapsedSec);
      $('#run-pace').textContent = U.pace(s.paceAvg);
      $('#run-now').textContent = U.pace(s.paceNow);
      badge.textContent = s.gpsAcc != null ? `GPS ±${Math.round(s.gpsAcc)}m` : 'GPS 取得中';
      badge.className = 'badge ' + (s.gpsAcc != null && s.gpsAcc <= 20 ? 'ok' : s.gpsAcc > 40 ? 'bad' : '');
      $('#btn-run-start').classList.add('hidden');
      $('#btn-run-pause').classList.remove('hidden');
      $('#btn-run-stop').classList.remove('hidden');
      $('#btn-run-pause').textContent = s.paused ? '再開' : '一時停止';
      const sc = $('#splits-card');
      sc.hidden = !s.splits.length;
      $('#splits').innerHTML = s.splits.map(sp =>
        `<div class="split"><b>${sp.km} km</b><span>${U.pace(sp.sec)} /km</span></div>`).join('');
    } else {
      $('#run-km').textContent = '0.00';
      $('#run-time').textContent = '0:00';
      $('#run-pace').textContent = '–:––';
      $('#run-now').textContent = '–:––';
      badge.textContent = 'GPS —'; badge.className = 'badge';
      $('#btn-run-start').classList.remove('hidden');
      $('#btn-run-pause').classList.add('hidden');
      $('#btn-run-stop').classList.add('hidden');
      $('#splits-card').hidden = true;
      $('#offroute').classList.add('hidden');
    }
    paintTarget(s);
    if (!$('#view-run').hidden) paintRunMap(s);
  }
  RN.tracker.on(renderRun);

  $('#btn-follow').onclick = () => {
    follow = !follow;
    S.settings.set('followMap', follow);
    $('#btn-follow').classList.toggle('on', follow);
    const s = RN.tracker.snapshot();
    if (follow && s && s.pos) RN.mapview.recenter('runmap', [s.pos.lat, s.pos.lng]);
    U.toast(follow ? '現在地に追従します' : '地図の追従を解除しました');
  };

  $('#btn-run-start').onclick = async () => {
    await RN.tracker.start(pendingPlan, pendingCourse);
    pendingPlan = null; pendingCourse = null;
    offCount = 0;
    U.toast('記録を開始しました。画面はつけたままにしてください');
  };
  $('#btn-run-pause').onclick = () => {
    const s = RN.tracker.snapshot();
    if (!s) return;
    s.paused ? RN.tracker.resume() : RN.tracker.pause();
  };
  $('#btn-run-stop').onclick = () => {
    const s = RN.tracker.snapshot();
    if (s && s.dist < 50 && !confirm('ほとんど記録されていません。破棄しますか？')) return;
    const saved = RN.tracker.stop();
    RN.mapview.liveReset('runmap');
    pendingPlan = null; pendingCourse = null; offCount = 0;
    if (saved) {
      U.toast(`${(saved.dist / 1000).toFixed(2)}km を保存しました`);
      renderLog();
      // land on the finished run itself — this is the moment you want to post it
      openRunDetail(saved);
    } else { U.toast('記録が短すぎたため保存しませんでした'); renderRun(null); }
  };

  /* =============== SNS共有 =============== */
  const shareState = { src: null, style: 'standard', cardURL: null };

  function openShare(src) {
    shareState.src = src;
    shareState.style = S.settings.get('shareStyle') || 'standard';
    $('#share-tags').value = S.settings.get('shareTags') || '';
    $('#card-preview').hidden = true;
    $('#card-preview').innerHTML = '';
    $('#share-card-send').classList.add('hidden');
    $('#share-card').classList.remove('hidden');
    if (shareState.cardURL) { URL.revokeObjectURL(shareState.cardURL); shareState.cardURL = null; }

    const chips = $('#share-styles');
    chips.innerHTML = '';
    Object.keys(RN.share.STYLES).forEach(k => {
      const b = U.el('button', 'chip chip-sm' + (k === shareState.style ? ' is-on' : ''),
        RN.share.STYLES[k].label);
      b.onclick = () => {
        shareState.style = k;
        S.settings.set('shareStyle', k);
        U.$$('#share-styles .chip').forEach(x => x.classList.toggle('is-on', x === b));
        paintShareText();
      };
      chips.appendChild(b);
    });

    paintShareText();
    $('#share-modal').hidden = false;
  }

  function paintShareText() {
    const t = RN.share.build(shareState.src, shareState.style, $('#share-tags').value);
    $('#share-text').value = t;
    updateCount();
  }

  function updateCount() {
    const t = $('#share-text').value;
    // X counts most CJK as 2 units against a 280 budget
    const units = Array.from(t).reduce((a, ch) => a + (/[\x00-\x7F]/.test(ch) ? 1 : 2), 0);
    const over = units > 280;
    $('#share-count').innerHTML = `${Array.from(t).length}文字`
      + `　／　X換算 <b style="color:${over ? 'var(--danger)' : 'var(--fg2)'}">${units}</b>/280`
      + (over ? '　<span style="color:var(--danger)">Xには長すぎます</span>' : '');
  }

  $('#share-text').addEventListener('input', updateCount);
  $('#share-tags').addEventListener('input', () => {
    S.settings.set('shareTags', $('#share-tags').value);
    paintShareText();
  });

  function closeShare() {
    $('#share-modal').hidden = true;
    if (shareState.cardURL) { URL.revokeObjectURL(shareState.cardURL); shareState.cardURL = null; }
  }
  $('#share-close').onclick = closeShare;
  $('#share-back').onclick = closeShare;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeShare(); });

  // must stay synchronous: iOS Safari rejects a clipboard write that is not
  // reached directly from the tap handler
  $('#share-copy').onclick = () => {
    const ta = $('#share-text');
    const text = ta.value;
    RN.share.copy(text).then(ok => {
      if (ok) { U.toast('コピーしました。SNSに貼り付けてください'); return; }
      // clipboard access can be refused (私用ブラウザ設定など). Select the text
      // so the fallback is one long-press away instead of a dead end.
      ta.focus(); ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (e) { }
      U.toast('自動コピーできませんでした。選択したので長押し→コピーしてください', true);
    });
  };

  $('#share-card').onclick = async () => {
    try {
      const cv = RN.share.card(shareState.src, { size: 1080 });
      const box = $('#card-preview');
      box.innerHTML = '';
      box.appendChild(cv);
      box.hidden = false;
      $('#share-card').classList.add('hidden');
      $('#share-card-send').classList.remove('hidden');
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      U.toast('画像を作成できませんでした（GPS軌跡がない記録かもしれません）', true);
    }
  };

  $('#share-card-send').onclick = async () => {
    const blob = await RN.share.cardBlob(shareState.src, { size: 1080 });
    if (!blob) return U.toast('画像を作成できませんでした', true);
    const d = RN.share.digest(shareState.src);
    const name = `run-${d.at ? U.ymd(d.at).replace(/\//g, '') : 'course'}-${(d.dist / 1000).toFixed(1)}km.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: $('#share-text').value });
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    if (shareState.cardURL) URL.revokeObjectURL(shareState.cardURL);
    shareState.cardURL = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = shareState.cardURL; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    U.toast('画像を保存しました');
  };

  /* =============== 履歴 =============== */
  function renderSaved() {
    const list = S.saved();
    $('#saved-block').hidden = !list.length;
    const box = $('#saved-list');
    box.innerHTML = '';
    list.forEach(r => {
      const names = r.stops.filter(s => !s.ghost).map(s => s.name).join(' → ') || r.modeLabel;
      const item = U.el('div', 'saved-item');
      item.innerHTML = `
        <div class="saved-body">
          <b>${U.esc(names)}</b>
          <em>${U.esc(r.modeLabel)}${r.elev ? '・' + U.esc(r.elev.label.text) + ' ↑' + r.elev.gain + 'm' : ''}
            ・保存 ${U.ymd(r.savedAt)}</em>
        </div>
        <div class="saved-km">${(r.distance / 1000).toFixed(2)}km</div>
        <button class="log-del" title="削除">✕</button>`;
      item.querySelector('.log-del').onclick = e => {
        e.stopPropagation();
        if (!confirm('この保存コースを削除しますか？')) return;
        S.unsaveCourse(r.id); renderSaved();
      };
      item.onclick = () => openDetail(r);
      box.appendChild(item);
    });
  }

  /** start of this week (Monday) and this month, in local time */
  function periodStarts() {
    const now = new Date();
    const wd = (now.getDay() + 6) % 7;                 // Mon = 0
    const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - wd).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return { week, month };
  }

  function renderLog() {
    renderSaved();
    const runs = S.runs();
    const pm = S.paceModel(state.km * 1000);
    const { week, month } = periodStarts();
    const sum = from => runs.filter(r => r.start >= from).reduce((a, r) => a + r.dist, 0) / 1000;
    const wk = sum(week), mo = sum(month);
    $('#st-week').textContent = wk.toFixed(1);
    $('#st-month').textContent = mo.toFixed(1);
    $('#st-pace').textContent = U.pace(pm.sec);
    $('#st-pace-src').textContent = '算出元：' + pm.src;
    const nWk = runs.filter(r => r.start >= week).length;
    const nMo = runs.filter(r => r.start >= month).length;
    $('#st-totals').textContent =
      `今週 ${nWk}本 ／ 今月 ${nMo}本 ／ 累計 ${runs.length}本 ${(runs.reduce((a, r) => a + r.dist, 0) / 1000).toFixed(1)}km`;

    const box = $('#log-list');
    box.innerHTML = '';
    if (!runs.length) {
      box.appendChild(U.el('div', 'empty', 'まだ記録がありません。\n「走る」タブでスタートすると記録されます。'));
      return;
    }
    runs.forEach(r => {
      const item = U.el('div', 'log-item');
      item.innerHTML = `
        <div class="log-date">
          <b>${U.ymdhm(r.start)}</b>
          <em>${U.hms(r.movingSec)}・${(r.plan && r.plan.name) ? U.esc(r.plan.name) : 'フリーラン'}</em>
        </div>
        <div class="log-nums">
          <b>${(r.dist / 1000).toFixed(2)}km</b>
          <em>${U.pace(r.movingSec / (r.dist / 1000))} /km</em>
        </div>
        <button class="log-del" title="削除">✕</button>`;
      item.querySelector('.log-del').onclick = e => {
        e.stopPropagation();
        if (!confirm('この記録を削除しますか？')) return;
        S.deleteRun(r.id); renderLog();
      };
      item.onclick = () => openRunDetail(r);
      box.appendChild(item);
    });
  }

  function openRunDetail(r) {
    if (!r.path || r.path.length < 2) return U.toast('この記録にはGPS軌跡がありません');
    state.route = null;
    show('detail');
    $('#detail-title').textContent = U.ymdhm(r.start);
    $('#btn-star').hidden = true;
    RN.mapview.showTrack(r, 'map');
    const eta = r.movingSec;
    $('#detail-sheet').innerHTML = `
          <div class="sheet-grab"></div>
          <div class="d-nums">
            <div><b>${(r.dist / 1000).toFixed(2)}</b><em>km</em></div>
            <div><b>${U.hms(eta)}</b><em>タイム</em></div>
            <div><b>${U.pace(r.movingSec / (r.dist / 1000))}</b><em>ペース /km</em></div>
          </div>
          <ul class="d-list">${(r.splits || []).map(s =>
          `<li><div class="d-ico">${s.km}</div><div class="d-body"><div class="d-name">${s.km} km 地点</div>
             <div class="d-sub">ラップ ${U.pace(s.sec)} /km</div></div></li>`).join('')}</ul>
          <div class="d-actions">
            <button class="btn-primary" id="btn-sns" style="margin-bottom:0">SNS用のテキストをつくる</button>
            <button class="btn-ghost wide" id="btn-gpx">GPXで書き出す</button>
          </div>`;
    $('#btn-sns').onclick = () => openShare(r);
    $('#btn-gpx').onclick = () => {
      U.download(`run-${U.ymd(r.start).replace(/\//g, '')}-${(r.dist / 1000).toFixed(1)}km.gpx`,
        RN.tracker.toGPX(r), 'application/gpx+xml');
      U.toast('GPXを保存しました');
    };
  }

  $('#btn-export-all').onclick = () => {
    const runs = S.runs();
    if (!runs.length) return U.toast('書き出す記録がありません', true);
    U.download('runnavi-runs.csv', RN.tracker.toCSV(runs), 'text/csv');
    U.toast(`${runs.length}件をCSVで書き出しました`);
  };

  /* =============== 設定 =============== */
  function paintSettings() {
    const s = S.settings.all;
    $$('#seg-engine .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.engine === s.engine));
    $('#in-key').value = s.gkey || '';
    $('#key-status').textContent = s.gkey
      ? (engineId() === 'google' ? '✅ Googleモードで動作中' : 'キーは保存済み（未使用）')
      : 'キー未設定 — オープンデータで動作します';
    $('#referrer-hint').textContent = location.origin + '/*';

    $$('#seg-pace-src .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.src === s.paceSrc));
    $('#in-pace-min').value = Math.floor(s.paceManual / 60);
    $('#in-pace-sec').value = Math.round(s.paceManual % 60);
    const pm = S.paceModel(state.km * 1000);
    $('#pace-note').textContent = `現在の基準：${U.pace(pm.sec)} /km（${pm.src}）`;
    $('#install-card').hidden = window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;

    const hs = RN.health.summary();
    $('#health-status').innerHTML = hs
      ? `✅ ${hs.count}本 取込済み（${U.ymd(hs.from)}〜${U.ymd(hs.to)}）／ 直近10本の平均 ${U.pace(hs.recentPace)} /km`
      : 'まだ取り込んでいません';
    paintEngineNote();
  }

  $$('#seg-engine .seg-btn').forEach(b => b.onclick = () => {
    const e = b.dataset.engine;
    if (e === 'google' && !S.settings.get('gkey')) {
      U.toast('先にAPIキーを登録してください', true);
      $('#in-key').focus(); return;
    }
    S.settings.set('engine', e);
    paintSettings();
  });

  $('#btn-key-save').onclick = async () => {
    const k = $('#in-key').value.trim();
    if (!k) return U.toast('キーを入力してください', true);
    S.settings.patch({ gkey: k, engine: 'google' });
    $('#key-status').textContent = '確認中…';
    try {
      await PV.google.init();
      await PV.google.geocode('東京駅');
      $('#key-status').textContent = '✅ Googleモードで動作中';
      U.toast('Googleマップと接続しました');
    } catch (e) {
      S.settings.patch({ engine: 'osm' });
      $('#key-status').textContent = '❌ ' + e.message;
      U.toast(e.message, true);
    }
    paintSettings();
  };
  $('#btn-key-clear').onclick = () => {
    S.settings.patch({ gkey: '', engine: 'osm' });
    paintSettings();
    U.toast('キーを削除しました');
  };

  $$('#seg-pace-src .seg-btn').forEach(b => b.onclick = () => {
    S.settings.set('paceSrc', b.dataset.src);
    paintSettings();
  });
  function readManualPace() {
    const m = Math.max(2, Math.min(15, +$('#in-pace-min').value || 6));
    const s = Math.max(0, Math.min(59, +$('#in-pace-sec').value || 0));
    S.settings.patch({ paceManual: m * 60 + s, paceSrc: 'manual' });
    paintSettings();
  }
  $('#in-pace-min').onchange = readManualPace;
  $('#in-pace-sec').onchange = readManualPace;

  $('#in-health').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('#health-status').textContent = `読み込み中… (${(f.size / 1048576).toFixed(0)}MB)`;
    try {
      const h = await RN.health.importFile(f, (frac, n) => {
        $('#health-status').textContent = `解析中 ${Math.round(frac * 100)}%（ランニング ${n}件）`;
      });
      U.toast(`${h.count}件のランニングを取り込みました`);
      S.settings.set('paceSrc', 'auto');
    } catch (err) {
      $('#health-status').textContent = '❌ ' + err.message;
      U.toast(err.message, true);
    }
    e.target.value = '';
    paintSettings();
  };

  $('#btn-export-health').onclick = () => {
    const runs = S.runs();
    if (!runs.length) return U.toast('書き出す記録がありません', true);
    U.download('runnavi-runs.csv', RN.tracker.toCSV(runs), 'text/csv');
  };

  $('#btn-wipe').onclick = () => {
    if (!confirm('この端末に保存したデータをすべて消します。よろしいですか？')) return;
    S.wipe(); location.reload();
  };

  function showUpdateBar() {
    if ($('#update-bar')) return;
    const bar = U.el('div', 'update-bar');
    bar.id = 'update-bar';
    bar.innerHTML = '<span>新しいバージョンがあります</span>';
    const b = U.el('button', 'update-btn', '更新');
    b.onclick = () => location.reload();
    const x = U.el('button', 'update-x', '✕');
    x.onclick = () => bar.remove();
    bar.appendChild(b); bar.appendChild(x);
    document.getElementById('app').appendChild(bar);
  }

  /* =============== boot =============== */
  function boot() {
    setKm(state.km);
    $$('#seg-mode .seg-btn').forEach(x => x.classList.toggle('is-on', x.dataset.mode === state.mode));
    $$('#cat-chips .chip').forEach(x => x.classList.toggle('is-on', x.dataset.cat === state.cat));
    $$('#hill-chips .chip').forEach(x => x.classList.toggle('is-on', x.dataset.hills === state.hills));
    $('#btn-follow').classList.toggle('on', follow);
    renderOriginHistory();
    paintSettings();
    paintCatHint();
    renderRun(null);

    const last = S.origins()[0];
    if (last) {
      inOrigin.value = last.label;
      state.origin = { label: last.label, lat: last.lat, lng: last.lng };
      loadWeather(state.origin);
    }

    const p = RN.tracker.pending();
    if (p && p.dist > 100) {
      setTimeout(() => {
        if (confirm(`前回の記録（${(p.dist / 1000).toFixed(2)}km）が途中で終わっています。再開しますか？\n「キャンセル」で保存して終了します。`)) {
          RN.tracker.resumeFrom(p); show('run');
        } else {
          RN.tracker.resumeFrom(p); const saved = RN.tracker.stop();
          if (saved) U.toast('前回の記録を保存しました');
          show('log');
        }
      }, 400);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(reg => {
        // A standalone PWA can sit on a stale build for days. When a new worker
        // finishes installing, offer the reload instead of waiting it out.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              if (RN.tracker.isActive()) return;      // never interrupt a run
              showUpdateBar();
            }
          });
        });
        setInterval(() => reg.update().catch(() => { }), 30 * 60e3);
      }).catch(() => { });
    }
    window.addEventListener('beforeunload', e => {
      if (RN.tracker.isActive()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  boot();
})();
