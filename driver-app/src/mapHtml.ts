/**
 * The map document rendered inside the WebView.
 *
 * Leaflet + OpenStreetMap tiles, inverted in CSS into a dark basemap. No API
 * key, no zoom controls, no scroll-wheel zoom: this is a stage for one route,
 * not a map to browse.
 *
 * The page exposes `window.__render(payload)` and posts messages back with
 * `{ type: 'pin', id }` or `{ type: 'status', value }` where value is 'ready',
 * 'offline' or 'tiles'. Nothing else from the page is trusted.
 */

export interface MapPin {
  id: number;
  lat: number;
  lng: number;
  label: string;
  tone: string;
  index?: number;
}

export interface MapPayload {
  mode: 'route' | 'pins';
  route: Array<[number, number]>;
  origin: [number, number] | null;
  destination: [number, number] | null;
  pins: MapPin[];
  reduceMotion: boolean;
  /** Height of whatever chrome owns the bottom of the stage, in px. */
  bottomInset?: number;
}

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

export function buildMapDocument(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" />
<style>
  html, body { margin:0; padding:0; height:100%; background:#101513; overflow:hidden; }
  #map { position:absolute; inset:0; background:#101513; }
  .leaflet-container { background:#101513; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  /*
   * OpenStreetMap ships light tiles only. Inverting + desaturating the tile pane
   * gives a dark basemap with no API key, while markers and the route stay in
   * the overlay pane and keep their real colours.
   */
  .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.62) contrast(0.82) saturate(0.2); }
  .leaflet-control-attribution {
    background:rgba(11,12,11,0.62) !important; color:rgba(238,241,234,0.45) !important;
    font-size:9px !important; padding:1px 5px !important; border-radius:4px 0 0 0;
  }
  .leaflet-control-attribution a { color:rgba(238,241,234,0.55) !important; }
  .marker-pin {
    width:26px; height:26px; border-radius:50%;
    background:#c9f94c; border:3px solid #0a0b08;
    box-shadow:0 0 0 4px rgba(201,249,76,0.16), 0 6px 14px rgba(0,0,0,0.55);
  }
  .marker-pin-inner { position:absolute; inset:6px; border-radius:50%; background:#0a0b08; }
  .marker-origin {
    width:14px; height:14px; border-radius:50%;
    border:2.5px solid rgba(238,241,234,0.82); background:#101513;
    box-shadow:0 0 0 3px rgba(10,11,8,0.55);
  }
  .marker-numbered {
    width:30px; height:30px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:13px; font-weight:700; color:#0a0b08; background:#c9f94c;
    border:2.5px solid #0a0b08; box-shadow:0 6px 14px rgba(0,0,0,0.55);
  }
</style>
</head>
<body>
<div id="map"></div>
<script src="${LEAFLET_JS}"></script>
<script>
(function () {
  function post(message) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (e) {}
  }
  if (typeof L === 'undefined') { post({ type: 'status', value: 'offline' }); return; }

  var map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: true,
    dragging: true,
    tap: false
  }).setView([0, 0], 13);

  var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    detectRetina: false,
    attribution: '&copy; OpenStreetMap contributors'
  });
  // Only a tile layer that has never loaded anything counts as broken; a single
  // dropped tile on a flaky link must not replace the stage with a fallback.
  var tileErrors = 0;
  var tileLoads = 0;
  tiles.on('tileload', function () { tileLoads += 1; });
  tiles.on('tileerror', function () {
    tileErrors += 1;
    if (tileErrors >= 3 && tileLoads === 0) { post({ type: 'status', value: 'tiles' }); }
  });
  tiles.addTo(map);

  var routeLayer = null;
  var markerLayer = L.layerGroup().addTo(map);
  var fitted = false;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clear() {
    markerLayer.clearLayers();
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  }

  window.__render = function (payload) {
    clear();
    var points = [];

    if (payload.mode === 'route' && payload.route && payload.route.length > 1) {
      routeLayer = L.layerGroup().addTo(map);
      L.polyline(payload.route, { color: '#060a07', weight: 13, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      L.polyline(payload.route, { color: 'rgba(201,249,76,0.13)', weight: 19, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      L.polyline(payload.route, { color: '#c9f94c', weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
      points = payload.route;
    }

    if (payload.origin) {
      points.push(payload.origin);
      L.marker(payload.origin, {
        icon: L.divIcon({ className: '', html: '<div class="marker-origin"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
        interactive: false
      }).addTo(markerLayer);
    }

    if (payload.destination) {
      points.push(payload.destination);
      L.marker(payload.destination, {
        icon: L.divIcon({
          className: '',
          html: '<div class="marker-pin"><div class="marker-pin-inner"></div></div>',
          iconSize: [26, 26], iconAnchor: [13, 13]
        }),
        interactive: false
      }).addTo(markerLayer);
    }

    if (payload.pins && payload.pins.length) {
      payload.pins.forEach(function (pin) {
        points.push([pin.lat, pin.lng]);
        var label = pin.index === undefined ? '' : String(pin.index);
        var marker = L.marker([pin.lat, pin.lng], {
          icon: L.divIcon({
            className: '',
            html: '<div class="marker-numbered" style="background:' + escapeHtml(pin.tone) + '">'
              + escapeHtml(label) + '</div>',
            iconSize: [30, 30], iconAnchor: [15, 15]
          })
        });
        marker.on('click', function () { post({ type: 'pin', id: pin.id }); });
        markerLayer.addLayer(marker);
      });
    }

    if (points.length === 1) {
      map.setView(points[0], 15, { animate: !payload.reduceMotion });
    } else if (points.length > 1) {
      // Padding clears the floating pill at the top and the dock at the bottom.
      // Horizontal padding stays small: on a narrow viewport a large symmetric
      // padding leaves no usable width and pushes the points off screen.
      // Pins mode sits under a list sheet, so it needs more bottom room than the
      // route stage, whose only bottom chrome is the action dock.
      var bottomPadding = payload.mode === 'pins' ? 300 : 136;
      // The route sheet owns the bottom of the stage, and it changes height as
      // the driver drags it. Framing the route under a fixed inset is what hid
      // the destination behind the details in v5.
      if (typeof payload.bottomInset === 'number' && payload.bottomInset > 0) {
        bottomPadding = Math.round(payload.bottomInset + 64);
      }
      // A sheet that covers most of the stage leaves no band to frame into; past
      // this point Leaflet has a negative viewport and stops reacting.
      var stageHeight = window.innerHeight || 800;
      bottomPadding = Math.min(bottomPadding, Math.round(stageHeight * 0.62));
      map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [28, 92],
        paddingBottomRight: [28, bottomPadding],
        maxZoom: 16,
        animate: !payload.reduceMotion,
        duration: payload.reduceMotion ? 0 : 0.4
      });
    }

    if (!fitted) { fitted = true; post({ type: 'status', value: 'ready' }); }
  };

  map.whenReady(function () { post({ type: 'status', value: 'ready' }); });
})();
</script>
</body>
</html>`;
}
