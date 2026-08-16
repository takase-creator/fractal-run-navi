/* ================= FRACTAL RUN NAVI :: map =================
   Leaflet is used for the in-app map on purpose: it costs nothing even when
   the Google engine is selected (Google only bills a "Dynamic Map" when a
   google.maps.Map is instantiated), and the dark basemap matches the UI.
   Actual turn-by-turn navigation is handed off to the Google Maps app.
   =========================================================== */
window.RN = window.RN || {};

RN.mapview = (function () {
  const U = RN.util;
  let map = null, layer = null;

  const TILE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const TILE_FALLBACK = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

  function ensure(elId) {
    if (map) return map;
    map = L.map(elId, {
      zoomControl: true, attributionControl: true,
      tap: true, preferCanvas: true
    });
    const tiles = L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR, subdomains: 'abcd' });
    tiles.on('tileerror', function once() {
      tiles.off('tileerror', once);
      tiles.setUrl(TILE_FALLBACK);
    });
    tiles.addTo(map);
    map.setView([35.6812, 139.7671], 13);
    layer = L.layerGroup().addTo(map);
    return map;
  }

  function pin(cls, text) {
    return L.divIcon({
      className: '', html: `<div class="pin ${cls}">${U.esc(text)}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  /** draw a planned route */
  function showRoute(route) {
    ensure('map');
    layer.clearLayers();
    const pts = (route.path || []).map(p => [p.lat, p.lng]);

    if (pts.length > 1) {
      L.polyline(pts, { color: '#0b0f14', weight: 9, opacity: .55 }).addTo(layer);
      L.polyline(pts, { color: '#00e5a0', weight: 4.5, opacity: .95, lineJoin: 'round' }).addTo(layer);
      // direction arrows every ~15% of the path
      const step = Math.max(1, Math.floor(pts.length / 7));
      for (let i = step; i < pts.length - 1; i += step) {
        const a = pts[i - 1], b = pts[i];
        const ang = U.bearing({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
        L.marker(b, {
          icon: L.divIcon({
            className: '', iconSize: [14, 14], iconAnchor: [7, 7],
            html: `<div style="transform:rotate(${ang}deg);color:#0bd0ff;font-size:13px;line-height:1;text-shadow:0 0 4px #0b0f14">▲</div>`
          }), interactive: false
        }).addTo(layer);
      }
    }

    L.marker([route.origin.lat, route.origin.lng], { icon: pin('start', 'S'), zIndexOffset: 900 })
      .addTo(layer).bindPopup('<b>スタート</b><br>' + U.esc(route.origin.label || ''));

    route.stops.forEach((s, i) => {
      const last = route.mode === 'one_way' && i === route.stops.length - 1;
      const m = L.marker([s.lat, s.lng], {
        icon: pin(last ? 'goal' : '', last ? 'G' : String(i + 1)), zIndexOffset: 800
      }).addTo(layer);
      const rev = s.reviews != null
        ? `<br>★${s.rating != null ? s.rating.toFixed(1) : '–'} ・クチコミ ${U.nfmt(s.reviews)}件`
        : (s.views ? `<br>Wikipedia 閲覧 ${U.nfmt(s.views)}/月` : '');
      m.bindPopup(`<b>${U.esc(s.name)}</b>${rev}`);
    });

    const bounds = pts.length > 1
      ? L.latLngBounds(pts)
      : L.latLngBounds([[route.origin.lat, route.origin.lng]].concat(route.stops.map(s => [s.lat, s.lng])));
    map.fitBounds(bounds.pad(0.12), { animate: false });
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  /** draw a recorded run */
  function showTrack(run) {
    ensure('map');
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

  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 60); }

  return { ensure, showRoute, showTrack, invalidate };
})();
