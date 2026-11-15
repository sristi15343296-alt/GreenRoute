/* Dashboard map preview: recorded trip endpoints only. */
(function () {
  "use strict";

  var container = document.getElementById("dashboard-map");
  var dataNode = document.getElementById("dashboard-map-data");
  if (!container || !dataNode) return;

  var trips;
  try {
    trips = JSON.parse(dataNode.textContent);
  } catch (error) {
    return;
  }
  var located = trips.filter(function (trip) { return trip.has_coordinates; });
  if (!located.length) return;

  if (!window.L || !L.maplibreGL) {
    container.innerHTML = '<div class="map-fallback">The map library could not be loaded. Recorded positions are still available on the fleet map page.</div>';
    return;
  }

  var map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false
  });

  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/dark",
    attributionControl: {
      customAttribution: '&copy; <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &middot; &copy; OpenMapTiles &middot; Data from OpenStreetMap'
    }
  }).addTo(map);

  var bounds = L.latLngBounds([]);
  var statusColors = {
    in_transit: "#e6b45c",
    scheduled: "#77828f",
    completed: "#45d89a",
    cancelled: "#e27a7a"
  };

  located.forEach(function (trip) {
    var start = trip.origin_coords;
    var end = trip.destination_coords;
    bounds.extend(start);
    bounds.extend(end);

    L.polyline([start, end], {
      color: "rgba(167, 176, 188, 0.28)",
      weight: 1,
      dashArray: "3 4",
      interactive: false
    }).addTo(map);

    L.circleMarker(start, {
      radius: 2.6,
      color: "#77828f",
      weight: 1.2,
      fillColor: "#77828f",
      fillOpacity: 0.55
    }).addTo(map);

    var marker = L.marker(end, {
      icon: L.divIcon({
        className: "fleet-marker-wrap",
        html: '<span class="fleet-marker fleet-marker--' + trip.status + '"></span>',
        iconSize: [0, 0],
        iconAnchor: [6, 6]
      }),
      title: trip.reference,
      keyboard: false
    }).addTo(map);

    var popup = document.createElement("div");
    popup.className = "dashboard-map-popup";
    var reference = document.createElement("strong");
    reference.textContent = trip.reference;
    var route = document.createElement("span");
    route.textContent = trip.origin + " → " + trip.destination;
    var detail = document.createElement("span");
    detail.textContent = trip.status_label + (trip.distance_km !== null ? " · " + Number(trip.distance_km).toFixed(1) + " km recorded" : "");
    var link = document.createElement("a");
    link.href = trip.url;
    link.textContent = "Open trip details";
    link.style.display = "inline-block";
    link.style.marginTop = "5px";
    link.style.color = "#a8b2be";
    link.style.fontSize = "9.5px";
    popup.appendChild(reference);
    popup.appendChild(route);
    popup.appendChild(detail);
    popup.appendChild(link);
    marker.bindPopup(popup);
    marker.on("mouseover", function () { marker.openTooltip(); });
    marker.bindTooltip(trip.reference, { className: "map-tooltip", direction: "top", offset: [0, -8] });
  });

  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 9 });
  } else {
    map.setView([48.8566, 2.3522], 5);
  }

  window.setTimeout(function () { map.invalidateSize(); }, 240);
})();
