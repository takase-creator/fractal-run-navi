/* ================= FRACTAL RUN NAVI :: providers =================
   Two interchangeable data back-ends behind one interface:

     google : Maps JavaScript API + Places API (New) + Directions API
              -> real Google review counts (userRatingCount). Needs an API key.
     osm    : Nominatim + Overpass + Wikipedia pageviews + FOSSGIS OSRM (foot)
              -> no key, no billing. Popularity = Wikipedia access counts.

   provider = {
     id, label, attribution,
     init(), geocode(q), reverse(p),
     searchRing({center,rInner,rOuter,category,onProgress}) -> [poi],
     route(points) -> {distance, duration, path}
   }
   poi = {id,name,lat,lng,pop(0-100),reviews|null,rating|null,kind,url|null}
   ================================================================ */
window.RN = window.RN || {};

RN.providers = (function () {
  const U = RN.util;

  /* ---------------------------------------------------------------
     shared helpers
     --------------------------------------------------------------- */

  /** even ring of points around center */
  function ringPoints(center, r, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(U.destPoint(center, i * 360 / n, r));
    return out;
  }

  /** how many sample circles to cover a ring of radius r, and their radius */
  function ringCover(r) {
    let n = 6;
    if (r > 4000) n = 8;
    if (r < 900) n = 5;
    const rc = Math.max(220, r * Math.sin(Math.PI / n) * 1.18);
    return { n, rc };
  }

  /** merge duplicates that sit within `tol` metres and share a name prefix */
  function dedupe(list, tol) {
    tol = tol || 130;
    const out = [];
    for (const p of list) {
      const hit = out.find(q =>
        U.haversine(q, p) < tol &&
        (q.name === p.name || q.name.includes(p.name) || p.name.includes(q.name)));
      if (hit) {
        if (p.pop > hit.pop) { hit.pop = Math.min(100, p.pop + 8); hit.kind = hit.kind || p.kind; }
        if (p.reviews && !hit.reviews) { hit.reviews = p.reviews; hit.rating = p.rating; }
        if (p.views) hit.views = Math.max(hit.views || 0, p.views);
        if (p.area && !hit.area) hit.area = p.area;
        if (p.url && !hit.url) hit.url = p.url;
      } else out.push(p);
    }
    return out;
  }

  const logScale = (v, full) => v > 0 ? Math.min(100, 100 * Math.log10(1 + v) / Math.log10(1 + full)) : 0;

  /* ===============================================================
     OSM / open-data provider
     =============================================================== */
  const osmLimit = U.rateLimiter(1100);   // be a good citizen on shared servers

  const OSM_KINDS = {
    park: { s: 58, icon: '🌳', label: '公園' },
    garden: { s: 52, icon: '🌸', label: '庭園' },
    nature_reserve: { s: 62, icon: '🌿', label: '自然保護区' },
    viewpoint: { s: 68, icon: '🔭', label: '展望' },
    attraction: { s: 54, icon: '📍', label: '名所' },
    museum: { s: 46, icon: '🏛', label: '博物館' },
    zoo: { s: 60, icon: '🦁', label: '動物園' },
    aquarium: { s: 60, icon: '🐟', label: '水族館' },
    theme_park: { s: 58, icon: '🎡', label: '遊園地' },
    gallery: { s: 40, icon: '🖼', label: 'ギャラリー' },
    beach: { s: 66, icon: '🏖', label: '海辺' },
    peak: { s: 64, icon: '⛰', label: '山' },
    place_of_worship: { s: 50, icon: '⛩', label: '神社仏閣' },
    castle: { s: 66, icon: '🏯', label: '城' },
    monument: { s: 44, icon: '🗿', label: '記念碑' },
    ruins: { s: 46, icon: '🏚', label: '史跡' },
    cafe: { s: 30, icon: '☕️', label: 'カフェ' },
    restaurant: { s: 28, icon: '🍽', label: '飲食店' },
    bakery: { s: 30, icon: '🥐', label: 'ベーカリー' },
    ice_cream: { s: 30, icon: '🍦', label: 'アイス' },
    wiki: { s: 40, icon: '📖', label: '名所' }
  };

  const OSM_TAGS = {
    scenery: [
      '[leisure~"^(park|garden|nature_reserve)$"][name]',
      '[tourism~"^(viewpoint|picnic_site)$"][name]',
      '[natural~"^(beach|peak|water)$"][name]'
    ],
    landmark: [
      '[tourism~"^(attraction|museum|zoo|aquarium|theme_park|gallery)$"][name]',
      '[historic~"^(castle|monument|ruins|archaeological_site)$"][name][wikidata]',
      '[amenity=place_of_worship][name][wikidata]',
      '[amenity=place_of_worship][name][religion~"shinto|buddhist"]',
      '[man_made~"^(tower|lighthouse)$"][name][wikidata]'
    ],
    food: [
      '[amenity~"^(cafe|bakery|ice_cream)$"][name]',
      '[amenity=restaurant][name][cuisine]'
    ]
  };
  OSM_TAGS.any = [].concat(OSM_TAGS.scenery, OSM_TAGS.landmark);

  /* Wikipedia geosearch returns every geotagged article — companies, offices,
     schools, stations. Only titles that read like a *destination* survive as
     standalone stops; everything else is used purely to score OSM features. */
  const PLACE_RE = new RegExp(
    '(公園|庭園|緑地|広場|神社|神宮|大社|八幡宮|八幡神社|稲荷|天満宮|東照宮|明神|' +
    '寺$|寺院|大仏|城$|城跡|城址|美術館|博物館|記念館|資料館|水族館|動物園|植物園|' +
    '遊園地|タワー|展望台|展望公園|大橋$|橋$|運河|湖$|池$|沼$|海岸|ビーチ|浜$|' +
    '山$|岳$|峠$|滝$|渓谷|球場|競技場|スタジアム|アリーナ|ドーム$|門$|坂$|' +
    '史跡|古墳|灯台|埠頭|ふ頭|遊歩道|並木|堤$|土手|川$|渓流|温泉|神域|参道)');
  const WIKI_JUNK_RE = new RegExp(
    '(株式会社|有限会社|ホールディングス|\\(企業\\)|（企業）|出版|放送|新聞|テレビ|' +
    '証券|銀行|保険|病院|クリニック|医院|大学$|高等学校|中学校|小学校|専門学校|' +
    '駅$|駅 |パーキングエリア|インターチェンジ|マンション|ホテル|事務所|' +
    '組合$|連合会|協同組合|PR会社|レコード|レーベル)');

  /* Trailing type token. "参宮橋" (the bridge) and "参宮橋公園" (a 0.5 ha pocket
     park) are different places, so a name may only absorb another article's
     pageviews when the two agree on what kind of thing they are. */
  const TYPE_SUF = new RegExp('(公園|緑地|広場|庭園|苑|神社|神宮|大社|八幡宮|稲荷|' +
    '天満宮|寺|院|城|美術館|博物館|記念館|資料館|水族館|動物園|植物園|会館|' +
    'タワー|展望台|競技場|球場|スタジアム|アリーナ|ドーム|駅|橋|川|池|沼|山|岳|坂|門)$');
  const sufOf = s => { const m = TYPE_SUF.exec(s); return m ? m[1] : ''; };

  /** does a Wikipedia title describe the same place as this OSM feature? */
  function nameAlike(a, b) {
    if (!a || !b) return false;
    const clean = s => String(s).replace(/[\s　・（）()「」【】]/g, '');
    const x = clean(a), y = clean(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const sx = sufOf(x), sy = sufOf(y);
    if (sx !== sy) return false;
    const bx = sx ? x.slice(0, -sx.length) : x;
    const by = sy ? y.slice(0, -sy.length) : y;
    if (!bx || !by) return false;
    return bx === by
      || (bx.length >= 2 && by.includes(bx))     // 北谷公園 ⊂ 渋谷区立北谷公園
      || (by.length >= 2 && bx.includes(by));
  }

  function osmKindOf(tags) {
    const t = tags || {};
    if (t.leisure && OSM_KINDS[t.leisure]) return t.leisure;
    if (t.tourism && OSM_KINDS[t.tourism]) return t.tourism;
    if (t.natural && OSM_KINDS[t.natural]) return t.natural;
    if (t.historic && OSM_KINDS[t.historic]) return t.historic;
    if (t.amenity === 'place_of_worship') return 'place_of_worship';
    if (t.amenity && OSM_KINDS[t.amenity]) return t.amenity;
    if (t.tourism) return 'attraction';
    return 'attraction';
  }

  const osm = {
    id: 'osm',
    label: 'オープンデータ',
    attribution: '© OpenStreetMap contributors · Wikipedia · FOSSGIS OSRM',

    async init() { return true; },

    async geocode(q) {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5' +
        '&accept-language=ja&addressdetails=1&q=' + encodeURIComponent(q);
      const r = await osmLimit(() => U.fetchJSON(url));
      return (r || []).map(x => ({
        label: (x.name && x.name.length > 1 ? x.name : x.display_name.split(',')[0]),
        detail: x.display_name,
        lat: +x.lat, lng: +x.lon
      }));
    },

    async reverse(p) {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ja&lat=${p.lat}&lon=${p.lng}`;
      try {
        const r = await osmLimit(() => U.fetchJSON(url));
        const a = r.address || {};
        return r.name || [a.neighbourhood, a.suburb, a.city || a.town || a.village]
          .filter(Boolean).join(' ') || '現在地';
      } catch (e) { return '現在地'; }
    },

    /* --- Overpass over the annulus, in a single request --- */
    async _overpass(center, rMid, tol, category) {
      const n = rMid > 3000 ? 16 : 12;
      const ring = ringPoints(center, rMid, n);
      ring.push(ring[0]);
      const coords = ring.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(',');
      const around = `(around:${Math.round(tol)},${coords})`;
      const sel = (OSM_TAGS[category] || OSM_TAGS.any)
        .map(f => `nwr${around}${f};`).join('');
      // `out bb` gives bounds for ways/relations (nodes keep lat/lon). The
      // footprint is the strongest free signal for "is this place a big deal":
      // 代々木公園 is ~1.1 km², a neighbourhood pocket park is ~2,000 m².
      const q = `[out:json][timeout:50];(${sel});out tags bb 400;`;

      const data = await osmLimit(() => U.fetchJSON(
        'https://overpass-api.de/api/interpreter',
        { method: 'POST', body: 'data=' + encodeURIComponent(q), timeout: 55000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));

      return (data.elements || []).map(e => {
        const t = e.tags || {};
        const nm = t['name:ja'] || t.name;
        if (!nm) return null;
        // OSM tags administrative bodies as place_of_worship too (神社本庁 etc.)
        if (/(本庁|本部$|事務局|事務所|教団|連合会|協同組合|出張所)/.test(nm)) return null;

        let lat, lng, area = 0;
        if (e.bounds) {
          const b = e.bounds;
          lat = (b.minlat + b.maxlat) / 2;
          lng = (b.minlon + b.maxlon) / 2;
          const h = U.haversine({ lat: b.minlat, lng: b.minlon }, { lat: b.maxlat, lng: b.minlon });
          const w = U.haversine({ lat: b.minlat, lng: b.minlon }, { lat: b.minlat, lng: b.maxlon });
          area = h * w * 0.72;                       // bbox -> rough real footprint
        } else if (e.lat != null) {
          lat = e.lat; lng = e.lon;
        } else return null;

        const kind = osmKindOf(t);
        let pop = (OSM_KINDS[kind] || OSM_KINDS.attraction).s * 0.55;
        if (area > 400) pop += 0.45 * logScale(area / 1000, 1200);
        if (t.wikidata || t.wikipedia) pop += 12;

        return {
          id: 'osm/' + e.type + '/' + e.id,
          name: nm,
          lat, lng, area,
          pop: Math.max(5, Math.min(100, pop)),
          reviews: null, rating: null, kind,
          url: null, wiki: t.wikipedia || null
        };
      }).filter(Boolean);
    },

    /* --- Wikipedia geosearch + 30-day pageviews = real popularity --- */
    async _wiki(center, rMid, onProgress) {
      const { n, rc } = ringCover(rMid);
      const spots = ringPoints(center, rMid, n);
      const out = [];
      const seenPage = new Set();
      // overlap the sectors generously — the Wikipedia API is free and fast, and
      // a famous landmark falling into a seam between circles is the one failure
      // mode that actually hurts the ranking.
      const radius = Math.min(10000, Math.round(rc * 1.55));
      await Promise.all(spots.map(async (s, i) => {
        const url = 'https://ja.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
          '&generator=geosearch&ggslimit=40&prop=pageviews|coordinates&pvipdays=30' +
          `&ggscoord=${s.lat.toFixed(5)}|${s.lng.toFixed(5)}&ggsradius=${radius}`;
        try {
          const r = await U.fetchJSON(url, { timeout: 15000 });
          const pages = (r.query && r.query.pages) || {};
          for (const k in pages) {
            const p = pages[k];
            const co = (p.coordinates || [])[0];
            if (!co || seenPage.has(p.pageid)) continue;
            const views = Object.values(p.pageviews || {}).reduce((a, b) => a + (b || 0), 0);
            if (views < 25) continue;                     // drop near-unknown articles
            seenPage.add(p.pageid);
            out.push({
              id: 'wiki/' + p.pageid,
              name: p.title,
              lat: co.lat, lng: co.lon,
              pop: logScale(views, 30000),
              reviews: null, rating: null, kind: 'wiki',
              views,
              standalone: PLACE_RE.test(p.title) && !WIKI_JUNK_RE.test(p.title),
              url: 'https://ja.wikipedia.org/?curid=' + p.pageid
            });
          }
        } catch (e) { /* one failed sector is survivable */ }
        if (onProgress) onProgress((i + 1) / n);
      }));
      return out;
    },

    async searchRing({ center, rInner, rOuter, category, onProgress }) {
      const rMid = (rInner + rOuter) / 2;
      const tol = Math.max(250, (rOuter - rInner) / 2);
      const key = `osm|${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${Math.round(rMid)}|${category}`;
      const cached = RN.store.cacheGet(key);
      if (cached) { if (onProgress) onProgress(1); return cached; }

      const wantWiki = category !== 'food';
      const [ov, wk] = await Promise.all([
        this._overpass(center, rMid, tol, category).catch(() => []),
        wantWiki ? this._wiki(center, rMid, onProgress).catch(() => []) : Promise.resolve([])
      ]);

      /* Wikipedia is primarily a *ranking* signal: attach each article's
         monthly pageviews to the OSM feature it describes. Only articles that
         read like a destination and match nothing survive on their own. */
      const claimed = new Set();
      for (const w of wk) {
        let best = null, bestD = 620;
        for (const p of ov) {
          const d = U.haversine(w, p);
          if (d < bestD && nameAlike(w.name, p.name)) { best = p; bestD = d; }
        }
        if (!best) continue;
        claimed.add(w.id);
        best.views = Math.max(best.views || 0, w.views);
        best.url = best.url || w.url;
        const vs = logScale(best.views, 30000);
        best.pop = Math.max(5, Math.min(100, Math.max(best.pop, 0.45 * best.pop + 0.62 * vs) + 8));
      }
      const solo = wk.filter(w => !claimed.has(w.id) && w.standalone && w.views >= 200);

      // keep only what actually sits in the band
      const band = p => {
        const d = U.haversine(center, p);
        return d >= rInner * 0.82 && d <= rOuter * 1.18;
      };
      const all = dedupe(ov.concat(solo).filter(band), 140)
        .sort((a, b) => b.pop - a.pop)
        .slice(0, 120);

      RN.store.cacheSet(key, all);
      if (onProgress) onProgress(1);
      return all;
    },

    async route(points) {
      const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}` +
        '?overview=full&geometries=geojson&continue_straight=false&annotations=false';
      const r = await osmLimit(() => U.fetchJSON(url, { timeout: 25000 }));
      if (r.code !== 'Ok' || !r.routes || !r.routes.length) throw new Error('route failed');
      const rt = r.routes[0];
      return {
        distance: rt.distance,
        duration: rt.duration,
        path: rt.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }))
      };
    }
  };

  /* ===============================================================
     Google provider
     =============================================================== */
  const G_TYPES = {
    scenery: ['park', 'national_park', 'garden', 'hiking_area', 'plaza', 'beach', 'observation_deck'],
    landmark: ['tourist_attraction', 'historical_landmark', 'monument', 'museum', 'art_gallery',
      'church', 'observation_deck'],
    food: ['cafe', 'coffee_shop', 'bakery', 'restaurant', 'japanese_restaurant', 'ice_cream_shop']
  };
  const G_BLOCK = new Set([
    'lodging', 'hotel', 'real_estate_agency', 'atm', 'bank', 'parking', 'gas_station',
    'car_repair', 'car_dealer', 'insurance_agency', 'storage', 'moving_company',
    'dentist', 'doctor', 'hospital', 'pharmacy', 'funeral_home', 'cemetery',
    'corporate_office', 'consultant', 'telecommunications_service_provider',
    'convenience_store', 'apartment_complex', 'apartment_building', 'child_care_agency'
  ]);
  const G_ICON = {
    park: '🌳', national_park: '🌲', garden: '🌸', hiking_area: '🥾', plaza: '⛲️',
    beach: '🏖', observation_deck: '🔭', tourist_attraction: '📍', historical_landmark: '🏯',
    monument: '🗿', museum: '🏛', art_gallery: '🖼', church: '⛩', place_of_worship: '⛩',
    cafe: '☕️', coffee_shop: '☕️', bakery: '🥐', restaurant: '🍽',
    japanese_restaurant: '🍱', ice_cream_shop: '🍦', stadium: '🏟', train_station: '🚉'
  };

  let gLoaded = null;
  function loadGoogle(key) {
    if (gLoaded) return gLoaded;
    gLoaded = new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.importLibrary)
        return resolve(window.google.maps);
      const cbName = '__rnGmapsReady';
      const to = setTimeout(() => reject(new Error('Google Maps の読み込みがタイムアウトしました')), 20000);
      window[cbName] = () => { clearTimeout(to); resolve(window.google.maps); };
      window.gm_authFailure = () => {
        clearTimeout(to);
        gLoaded = null;
        reject(new Error('APIキーが拒否されました（キーの制限・請求先・API有効化を確認してください）'));
      };
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
        '&v=weekly&libraries=places,geometry,marker&language=ja&region=JP' +
        '&loading=async&callback=' + cbName;
      s.onerror = () => { clearTimeout(to); gLoaded = null; reject(new Error('Google Maps に接続できませんでした')); };
      document.head.appendChild(s);
    });
    return gLoaded;
  }

  const google_ = {
    id: 'google',
    label: 'Google マップ',
    attribution: 'Powered by Google',
    _lib: null,

    async init() {
      const key = RN.store.settings.get('gkey');
      if (!key) throw new Error('Google APIキーが未設定です');
      await loadGoogle(key);
      if (!this._lib) {
        const [places, routes, geocoding] = await Promise.all([
          google.maps.importLibrary('places'),
          google.maps.importLibrary('routes'),
          google.maps.importLibrary('geocoding')
        ]);
        this._lib = { places, routes, geocoding };
        this._geocoder = new geocoding.Geocoder();
        this._dir = new routes.DirectionsService();
      }
      return true;
    },

    async geocode(q) {
      await this.init();
      const r = await this._geocoder.geocode({ address: q, region: 'jp', language: 'ja' });
      return (r.results || []).slice(0, 5).map(x => ({
        label: (x.address_components && x.address_components[0] && x.address_components[0].long_name)
          || x.formatted_address,
        detail: x.formatted_address,
        lat: x.geometry.location.lat(), lng: x.geometry.location.lng()
      }));
    },

    async reverse(p) {
      await this.init();
      try {
        const r = await this._geocoder.geocode({ location: p, language: 'ja' });
        const best = (r.results || [])[0];
        return best ? best.formatted_address.replace(/^日本、?\s*/, '') : '現在地';
      } catch (e) { return '現在地'; }
    },

    async searchRing({ center, rInner, rOuter, category, onProgress }) {
      await this.init();
      const rMid = (rInner + rOuter) / 2;
      const key = `g|${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${Math.round(rMid)}|${category}`;
      const cached = RN.store.cacheGet(key);
      if (cached) { if (onProgress) onProgress(1); return cached; }

      const { places } = this._lib;
      const { n, rc } = ringCover(rMid);
      const spots = ringPoints(center, rMid, n);
      const fields = ['id', 'displayName', 'location', 'rating', 'userRatingCount',
        'types', 'primaryType', 'googleMapsURI'];
      const types = G_TYPES[category] || null;

      let done = 0;
      const batches = await Promise.all(spots.map(async s => {
        const req = {
          fields,
          locationRestriction: { center: new google.maps.LatLng(s.lat, s.lng), radius: Math.min(45000, rc) },
          maxResultCount: 20,
          rankPreference: places.SearchNearbyRankPreference.POPULARITY,
          language: 'ja', region: 'jp'
        };
        if (types) req.includedPrimaryTypes = types;
        try {
          const { places: found } = await places.Place.searchNearby(req);
          return found || [];
        } catch (e) { console.warn('searchNearby', e && e.message); return []; }
        finally { done++; if (onProgress) onProgress(done / n); }
      }));

      const out = [];
      for (const p of batches.flat()) {
        const reviews = p.userRatingCount || 0;
        if (reviews < 8) continue;
        const tset = p.types || [];
        if (!types && tset.some(t => G_BLOCK.has(t))) continue;
        const loc = p.location;
        const q = { lat: loc.lat(), lng: loc.lng() };
        const d = U.haversine(center, q);
        if (d < rInner * 0.82 || d > rOuter * 1.18) continue;
        const rating = p.rating || null;
        // review volume dominates, star rating modulates
        const pop = logScale(reviews, 20000) * (rating ? (0.72 + 0.28 * (rating / 5)) : 0.86);
        const kind = p.primaryType || tset[0] || 'tourist_attraction';
        out.push({
          id: 'g/' + p.id,
          name: p.displayName || '(名称なし)',
          lat: q.lat, lng: q.lng,
          pop: Math.min(100, pop), reviews, rating, kind,
          url: p.googleMapsURI || null
        });
      }
      const all = dedupe(out, 90).sort((a, b) => b.pop - a.pop).slice(0, 120);
      RN.store.cacheSet(key, all);
      if (onProgress) onProgress(1);
      return all;
    },

    async route(points) {
      await this.init();
      const wp = points.slice(1, -1).map(p => ({ location: new google.maps.LatLng(p.lat, p.lng), stopover: true }));
      const res = await this._dir.route({
        origin: new google.maps.LatLng(points[0].lat, points[0].lng),
        destination: new google.maps.LatLng(points[points.length - 1].lat, points[points.length - 1].lng),
        waypoints: wp,
        optimizeWaypoints: false,
        travelMode: google.maps.TravelMode.WALKING,
        language: 'ja', region: 'jp'
      });
      const rt = res.routes[0];
      let distance = 0, duration = 0;
      rt.legs.forEach(l => { distance += l.distance.value; duration += l.duration.value; });
      return {
        distance, duration,
        path: (rt.overview_path || []).map(p => ({ lat: p.lat(), lng: p.lng() }))
      };
    }
  };

  /* --------------------------------------------------------------- */
  function iconFor(poi) {
    if (!poi) return '📍';
    if (poi.id && poi.id.startsWith('g/')) return G_ICON[poi.kind] || '📍';
    return (OSM_KINDS[poi.kind] || OSM_KINDS.attraction).icon;
  }
  /** short "why this place" badge for the UI */
  function popLabel(poi) {
    if (!poi || poi.ghost) return '';
    if (poi.reviews != null) return `クチコミ${U.nfmt(poi.reviews)}件`;
    if (poi.views) return `Wikipedia ${U.nfmt(poi.views)}回/月`;
    if (poi.area > 20000) return `広さ ${(poi.area / 10000).toFixed(1)}ha`;
    return '';
  }

  function kindLabel(poi) {
    if (!poi) return '';
    if (poi.id && poi.id.startsWith('g/'))
      return String(poi.kind || '').replace(/_/g, ' ');
    return (OSM_KINDS[poi.kind] || OSM_KINDS.attraction).label;
  }

  function get(id) { return id === 'google' ? google_ : osm; }

  return { get, osm, google: google_, iconFor, kindLabel, popLabel, loadGoogle, ringPoints, ringCover };
})();
