/* ================= FRACTAL RUN NAVI :: map =================
   Leaflet is used for the in-app maps on purpose: it costs nothing even when
   the Google engine is selected (Google only bills a "Dynamic Map" when a
   google.maps.Map is instantiated), and the dark basemap matches the UI.
   Turn-by-turn navigation is handed off to the Google Maps app.

   Several maps coexist (course detail, live run), so instances are kept in a
   registry keyed by container id rather than in a single module-level slot.
   =========================================================== */
window.RN = window.RN || {};

RN.mapview = (function () {
  const U = RN.util;
  const reg = {};                       // elId -> {map, layer, live}

  const TILE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const TILE_FALLBACK = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

  function ensure(elId) {
    if (reg[elId]) return reg[elId];
    const map = L.map(elId, {
      zoomControl: true, attributionControl: true, tap: true, preferCanvas: true
    });
    const tiles = L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR, subdomains: 'abcd' });
    tiles.on('tileerror', function once() { tiles.off('tileerror', once); tiles.setUrl(TILE_FALLBACK); });
    tiles.addTo(map);
    map.setView([35.6812, 139.7671], 13);
    reg[elId] = { map, layer: L.layerGroup().addTo(map), live: L.layerGroup().addTo(map) };
    return reg[elId];
  }

  function pin(cls, text) {
    return L.divIcon({
      className: '', html: `<div class="pin ${cls}">${U.esc(text)}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  function drawArrows(layer, pts, color) {
    const step = Math.max(1, Math.floor(pts.length / 7));
    for (let i = step; i < pts.length - 1; i += step) {
      const a = pts[i - 1], b = pts[i];
      const ang = U.bearing({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
      L.marker(b, {
        icon: L.divIcon({
          className: '', iconSize: [14, 14], iconAnchor: [7, 7],
          html: `<div style="transform:rotate(${ang}deg);color:${color};font-size:13px;line-height:1;text-shadow:0 0 4px #0b0f14">▲</div>`
        }), interactive: false
      }).addTo(layer);
    }
  }

  /** draw a planned route */
  function showRoute(route, elId) {
    const { map, layer } = ensure(elId || 'map');
    layer.clearLayers();
    const pts = (route.path || []).map(p => [p.lat, p.lng]);

    if (pts.length > 1) {
      L.polyline(pts, { color: '#0b0f14', weight: 9, opacity: .55 }).addTo(layer);
      L.polyline(pts, { color: '#00e5a0', weight: 4.5, opacity: .95, lineJoin: 'round' }).addTo(layer);
      drawArrows(layer, pts, '#0bd0ff');
    }

    L.marker([route.origin.lat, route.origin.lng], { icon: pin('start', 'S'), zIndexOffset: 900 })
      .addTo(layer).bindPopup('<b>スタート</b><br>' + U.esc(route.origin.label || ''));

    route.stops.forEach((s, i) => {
      const last = route.mode === 'one_way' && i === route.stops.length - 1;
      const m = L.marker([s.lat, s.lng], {
        icon: pin(last ? 'goal' : '', last ? 'G' : String(i + 1)), zIndexOffset: 800
      }).addTo(layer);
      const badge = RN.providers.popLabel(s);
      m.bindPopup(`<b>${U.esc(s.name)}</b>${badge ? '<br>' + U.esc(badge) : ''}`);
    });

    const bounds = pts.length > 1
      ? L.latLngBounds(pts)
      : L.latLngBounds([[route.origin.lat, route.origin.lng]].concat(route.stops.map(s => [s.lat, s.lng])));
    map.fitBounds(bounds.pad(0.12), { animate: false });
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  /** draw a recorded run */
  function showTrack(run, elId) {
    const { map, layer } = ensure(elId || 'map');
    layer.clearLayers();
    const pts = (run.path || []).map(p => [p[0], p[1]]);
    if (pts.length > 1) {
      L.polyline(pts, { color: '#0b0f14', weight: 9, opacity: .55 }).addTo(layer);
      L.polyline(pts, { color: '#0bd0ff', weight: 4.5, opacity: .95 }).addTo(layer);
      L.marker(pts[0], { icon: pin('start', 'S') }).addTo(layer);
      L.marker(pts[pts.length - 1], { icon: pin('goal', 'G') }).addTo(layer);
      map.fitBounds(L.latLngBounds(pts).pad(0.12), { animate: false });
    }
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  /* ---------------- live run map ----------------
     The planned course is painted once into `layer`; only the breadcrumb and
     the position dot are redrawn on every GPS fix, so this stays cheap enough
     to run for an hour on a phone.                                          */

  let liveState = { routeId: null, marker: null, trail: null, lastPan: 0, zoomed: false };

  function liveSetRoute(route, elId) {
    const { map, layer } = ensure(elId);
    const key = route ? route.id : null;
    if (liveState.routeId === key) return;
    liveState.routeId = key;
    layer.clearLayers();
    if (!route) return;
    const pts = (route.path || []).map(p => [p.lat, p.lng]);
    if (pts.length > 1) {
      L.polyline(pts, { color: '#0b0f14', weight: 11, opacity: .7 }).addTo(layer);
      L.polyline(pts, { color: '#00e5a0', weight: 6, opacity: .9, lineJoin: 'round' }).addTo(layer);
      drawArrows(layer, pts, '#0bd0ff');
    }
    route.stops.forEach((s, i) => {
      L.marker([s.lat, s.lng], { icon: pin('', String(i + 1)), zIndexOffset: 700 })
        .addTo(layer).bindPopup(U.esc(s.name));
    });
    L.marker([route.origin.lat, route.origin.lng], { icon: pin('start', 'S'), zIndexOffset: 800 }).addTo(layer);
    map.fitBounds(L.latLngBounds(pts.length > 1 ? pts : [[route.origin.lat, route.origin.lng]]).pad(0.14),
      { animate: false });
  }

  /** @param path [[lat,lng,t,acc], ...] */
  function liveUpdate(elId, path, opts) {
    const inst = ensure(elId);
    const { map, live } = inst;
    const pts = (path || []).map(p => [p[0], p[1]]);
    if (!pts.length) return;

    if (!liveState.trail) {
      liveState.trail = L.polyline(pts, { color: '#ff5470', weight: 4, opacity: .9 }).addTo(live);
    } else {
      liveState.trail.setLatLngs(pts);
      if (!live.hasLayer(liveState.trail)) liveState.trail.addTo(live);
    }
    const last = pts[pts.length - 1];
    if (!liveState.marker) {
      liveState.marker = L.marker(last, { icon: pin('live', '●'), zIndexOffset: 1000 }).addTo(live);
    } else {
      liveState.marker.setLatLng(last);
      if (!live.hasLayer(liveState.marker)) liveState.marker.addTo(live);
    }

    if (!(opts && opts.follow)) return;
    // Recentre at most once a second and without animation: the marker is a DOM
    // element while the trail is on canvas, and animating a pan that is
    // superseded before it finishes leaves the two visibly out of step.
    const now = Date.now();
    if (now - liveState.lastPan < 900) return;
    liveState.lastPan = now;
    // zoom in once on the first fix, then leave the user's zoom alone
    const z = liveState.zoomed ? map.getZoom() : 16;
    liveState.zoomed = true;
    map.setView(last, z, { animate: false });
  }

  function liveReset(elId) {
    const inst = reg[elId];
    liveState = { routeId: null, marker: null, trail: null, lastPan: 0, zoomed: false };
    if (inst) { inst.live.clearLayers(); inst.layer.clearLayers(); }
  }

  function invalidate(elId) {
    const inst = reg[elId || 'map'];
    if (inst) setTimeout(() => inst.map.invalidateSize(), 60);
  }

  function recenter(elId, latlng) {
    const inst = reg[elId];
    if (inst && latlng) inst.map.setView(latlng, Math.max(inst.map.getZoom(), 16));
  }

  return {
    ensure, showRoute, showTrack, invalidate, recenter,
    liveSetRoute, liveUpdate, liveReset
  };
})();
