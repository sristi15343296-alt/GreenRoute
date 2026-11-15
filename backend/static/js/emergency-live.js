/*
 * Live emergency vehicle overlay for the fleet map.
 *
 * Transport choice for Phase C: polling. The whole polling contract is
 * `/api/live/positions?since=<event_id>`, and the admin asks for everything newer
 * than the last fix id it saw. Because `event_id` is the telemetry fix id — a
 * monotonic primary key assigned by the same insert that stores the position —
 * a later transport (SSE or Socket.IO) can push the same payloads without
 * touching ingestion, the database or this view's rendering code.
 *
 * What it does:
 *   - polls every 5 s (configurable with data-poll)
 *   - draws one marker per ACTIVE response, coloured by telemetry health
 *   - keeps a marker when its fix goes stale rather than hiding the vehicle:
 *     "last known position" is operationally useful, "fresh position" is not
 *   - fetches a trail + active route on demand
 *   - shows a warning strip when a unit goes STALE or LOST; it never changes an
 *     emergency's state on its own
 */
(function () {
  "use strict";

  var shell = document.getElementById("map-shell");
  var overlay = document.getElementById("live-overlay");
  if (!shell || !overlay) return;
  if (!window.GR || !window.GR.fleetMap) return;

  var POLL_MS = Math.max(2000, Number(overlay.getAttribute("data-poll") || 5000));
  var HEALTH_COLOR = {
    LIVE: "#6fd08c",
    DELAYED: "#e3b04b",
    STALE: "#e58a3c",
    LOST: "#e5674f",
    UNKNOWN: "#8b948a"
  };
  var HEALTH_LABEL = {
    LIVE: "Live",
    DELAYED: "Delayed",
    STALE: "Stale",
    LOST: "Signal lost",
    UNKNOWN: "No telemetry"
  };

  var map = window.GR.fleetMap;
  var layer = L.layerGroup().addTo(map);
  var trailLayer = L.layerGroup().addTo(map);
  var markers = {};
  var latest = {};
  var cursor = 0;
  var timer = null;
  var failures = 0;
  var polls = 0;
  var selected = null;

  var countEl = document.getElementById("live-count");
  var stateEl = document.getElementById("live-state");
  var warnEl = document.getElementById("live-warning");

  function money(value, digits) {
    return value === null || value === undefined ? "—" : Number(value).toFixed(digits);
  }

  function ageLabel(seconds) {
    if (seconds === null || seconds === undefined) return "no report";
    if (seconds < 60) return seconds + " s ago";
    var minutes = Math.round(seconds / 60);
    return minutes + " min ago";
  }

  function directionLabel(heading) {
    if (heading === null || heading === undefined) return null;
    var points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return points[Math.round(Number(heading) / 45) % 8];
  }

  function markerHtml(item) {
    var health = (item.health && item.health.status) || "UNKNOWN";
    var color = HEALTH_COLOR[health] || HEALTH_COLOR.UNKNOWN;
    var heading = item.position && item.position.heading_deg;
    var rotate = heading === null || heading === undefined ? 0 : Number(heading);
    var faded = health === "STALE" || health === "LOST" || health === "UNKNOWN";
    return (
      '<div class="live-marker' + (faded ? " is-stale" : "") + '" style="--live-color:' + color + '">' +
      '<span class="live-marker-arrow" style="transform:rotate(' + rotate + 'deg)"></span>' +
      '<span class="live-marker-dot"></span>' +
      '<span class="live-marker-label mono">' + window.GR.escapeHtml(item.call_sign || item.reference) + "</span>" +
      "</div>"
    );
  }

  function popupHtml(item) {
    var health = (item.health && item.health.status) || "UNKNOWN";
    var position = item.position || {};
    var route = item.route || {};
    var rows = [
      ["Unit", window.GR.escapeHtml(item.call_sign || "unassigned")],
      ["Health", HEALTH_LABEL[health] + " · " + ageLabel(item.health && item.health.age_seconds)],
      ["Speed", position.speed_mps === null || position.speed_mps === undefined
        ? "—"
        : (Number(position.speed_mps) * 3.6).toFixed(0) + " km/h"],
      ["Heading", directionLabel(position.heading_deg) || "—"],
      ["Accuracy", position.accuracy_m === null || position.accuracy_m === undefined
        ? "—"
        : "±" + money(position.accuracy_m, 0) + " m"],
      ["Off route", route.deviation_m === null || route.deviation_m === undefined
        ? "—"
        : money(route.deviation_m, 0) + " m"],
      ["Route", (route.quality || "none") + (route.provider ? " · " + route.provider : "")]
    ];
    var html = '<div class="live-popup"><strong>' + window.GR.escapeHtml(item.reference) + "</strong>" +
      '<p class="live-popup-sub">' + window.GR.escapeHtml(item.destination || "") + "</p><dl>";
    rows.forEach(function (row) {
      html += "<dt>" + row[0] + "</dt><dd>" + row[1] + "</dd>";
    });
    html += "</dl>";
    if (health === "STALE" || health === "LOST") {
      html += '<p class="live-popup-warn">This position is historical. The emergency is still ' +
        (item.session_state || "ACTIVE").toLowerCase() + " — resolve it deliberately.</p>";
    }
    html += '<button type="button" class="btn btn-secondary btn-sm" data-live-trail="' + item.trip_id +
      '">Show trail</button></div>';
    return html;
  }

  function upsert(item) {
    latest[item.trip_id] = item;
    var point = item.position ? [item.position.lat, item.position.lng] : null;
    var existing = markers[item.trip_id];

    if (existing && !point) {
      // Keep the last known marker rather than deleting it: a vehicle that
      // stopped reporting did not stop existing.
      existing.setPopupContent(popupHtml(item));
      return;
    }
    if (!point) return;

    var icon = L.divIcon({
      className: "live-marker-wrap",
      html: markerHtml(item),
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    if (existing) {
      existing.setLatLng(point);
      existing.setIcon(icon);
      existing.setPopupContent(popupHtml(item));
    } else {
      var marker = L.marker(point, { icon: icon, keyboard: false, zIndexOffset: 900 })
        .addTo(layer)
        .bindPopup(popupHtml(item));
      markers[item.trip_id] = marker;
    }
  }

  function refreshSummary() {
    var items = Object.keys(latest).map(function (key) { return latest[key]; });
    var stale = items.filter(function (item) {
      return item.health && (item.health.status === "STALE" || item.health.status === "LOST");
    });
    var missing = items.filter(function (item) { return !item.position; });

    countEl.textContent = String(items.length);
    if (failures > 0) {
      stateEl.textContent = "reconnecting…";
      stateEl.className = "mono live-state is-warn";
    } else {
      stateEl.textContent = "polling " + Math.round(POLL_MS / 1000) + "s";
      stateEl.className = "mono live-state";
    }

    if (stale.length || missing.length) {
      var names = stale.concat(missing).map(function (item) {
        return (item.call_sign || item.reference) + " (" +
          ((item.health && item.health.status) || "UNKNOWN").toLowerCase() + ")";
      });
      warnEl.hidden = false;
      warnEl.textContent = "Telemetry warning: " + names.join(", ") +
        ". Their positions are not current; the responses themselves are unchanged.";
    } else {
      warnEl.hidden = true;
      warnEl.textContent = "";
    }
  }

  function poll() {
    // The cursor only advances when a position changes, so a response that was
    // just activated and has not reported yet would never arrive. A full poll
    // every sixth tick (30 s by default) picks those up, and also recovers from
    // any missed change.
    polls += 1;
    var full = cursor === 0 || polls % 6 === 0;
    var url = "/api/live/positions" + (!full && cursor ? "?since=" + cursor : "");
    window.GR.api(url).then(function (data) {
      failures = 0;
      if (typeof data.event_id === "number") {
        cursor = Math.max(cursor, data.event_id);
      }
      (data.positions || []).forEach(upsert);

      // Anything that did not change in this poll still needs its age refreshed,
      // otherwise a frozen marker would keep claiming to be live.
      Object.keys(latest).forEach(function (key) {
        var item = latest[key];
        if (item.health && item.health.age_seconds !== null) {
          item.health.age_seconds += Math.round(POLL_MS / 1000);
          var age = item.health.age_seconds;
          item.health.status =
            age <= 15 ? "LIVE" : age <= 45 ? "DELAYED" : age <= 120 ? "STALE" : "LOST";
          var marker = markers[item.trip_id];
          if (marker) {
            marker.setIcon(L.divIcon({
              className: "live-marker-wrap",
              html: markerHtml(item),
              iconSize: [26, 26],
              iconAnchor: [13, 13]
            }));
          }
        }
      });
      refreshSummary();
    }).catch(function () {
      failures += 1;
      refreshSummary();
    });
  }

  function loadTrail(tripId) {
    window.GR.api("/api/live/sessions/" + tripId + "/track?limit=300").then(function (data) {
      trailLayer.clearLayers();
      selected = tripId;
      var trail = data.trail || [];
      if (trail.length > 1) {
        L.polyline(trail.map(function (fix) { return [fix.lat, fix.lng]; }), {
          color: "#c9f94c",
          weight: 3,
          opacity: 0.85,
          dashArray: "6 6"
        }).addTo(trailLayer);
      }
      if (data.route && data.route.geometry && data.route.geometry.length > 1) {
        L.polyline(data.route.geometry, {
          color: "#5ea8e6",
          weight: 4,
          opacity: 0.9
        }).addTo(trailLayer);
      }
      window.GR.toast(
        data.trail && data.trail.length
          ? "Showing " + data.trail.length + " recent fixes for " + data.reference + "."
          : "No fixes recorded yet for " + data.reference + "."
      );
    }).catch(function (error) {
      window.GR.toast(error.message, "error");
    });
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-live-trail]");
    if (!button) return;
    event.preventDefault();
    loadTrail(button.getAttribute("data-live-trail"));
  });

  refreshSummary();
  poll();
  timer = window.setInterval(poll, POLL_MS);

  // A hidden tab does not need to poll; on return, catch up immediately.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      window.clearInterval(timer);
      timer = null;
    } else if (!timer) {
      poll();
      timer = window.setInterval(poll, POLL_MS);
    }
  });

  window.GR.live = {
    refresh: poll,
    clearTrail: function () { trailLayer.clearLayers(); selected = null; },
    stop: function () { if (timer) window.clearInterval(timer); timer = null; }
  };
})();
