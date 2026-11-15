/* Trip details: endpoint map, coordinate lookup and creation feedback. */
(function () {
  "use strict";

  var dataNode = document.getElementById("trip-detail-data");
  if (!dataNode) return;

  var payload;
  try {
    payload = JSON.parse(dataNode.textContent);
  } catch (error) {
    return;
  }
  var trip = payload && payload.trip && typeof payload.trip === "object" ? payload.trip : payload;
  if (!trip || typeof trip !== "object") return;
  var params = new URLSearchParams(window.location.search);

  if (params.get("created") === "1") {
    window.setTimeout(function () {
      if (params.get("unrouted") === "1") {
        window.GR.toast("Trip recorded without route coordinates.", "warn");
      } else {
        window.GR.toast("Trip recorded.");
      }
    }, 180);
  }

  var mapContainer = document.getElementById("trip-detail-map");
  var emptyPanel = document.querySelector("[data-map-empty]");
  var statusNode = document.querySelector("[data-lookup-status]");
  var routeTag = document.querySelector("[data-route-tag]");
  var map = null;
  var endpointLayer = null;
  var hasCoordinates = Boolean(trip.has_coordinates);

  function validPoint(coords) {
    if (!coords || coords.length !== 2) return null;
    var lat = Number(coords[0]);
    var lng = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }

  function formatPoint(coords) {
    var point = validPoint(coords);
    return point ? point[0].toFixed(5) + ", " + point[1].toFixed(5) : "—";
  }

  function setStatus(message, tone) {
    if (!statusNode) return;
    if (!message) {
      statusNode.hidden = true;
      statusNode.textContent = "";
      return;
    }
    statusNode.hidden = false;
    statusNode.textContent = message;
    statusNode.className = "empty-note" + (tone ? " empty-note--" + tone : "");
  }

  function drawEndpoints() {
    if (!map || !endpointLayer) return;
    endpointLayer.clearLayers();
    var start = validPoint(trip.origin_coords);
    var end = validPoint(trip.destination_coords);
    if (!start || !end) return;

    L.polyline([start, end], {
      color: "#080b10",
      weight: 8,
      opacity: 0.85
    }).addTo(endpointLayer);
    L.polyline([start, end], {
      color: "#c9f94c",
      weight: 2.8,
      opacity: 0.95,
      dashArray: "8 5"
    }).addTo(endpointLayer);

    L.circleMarker(start, {
      radius: 5.8,
      color: "#f0f3f6",
      weight: 1.8,
      fillColor: "#c9f94c",
      fillOpacity: 1
    }).bindTooltip("Origin · " + trip.reference, {
      permanent: true,
      direction: "top",
      offset: [0, -8],
      className: "map-tooltip"
    }).addTo(endpointLayer);

    L.circleMarker(end, {
      radius: 6.6,
      color: "#f0f3f6",
      weight: 2.2,
      fillColor: "#11161d",
      fillOpacity: 1
    }).bindTooltip("Destination · " + trip.reference, {
      permanent: true,
      direction: "bottom",
      offset: [0, 8],
      className: "map-tooltip"
    }).addTo(endpointLayer);

    map.fitBounds(L.latLngBounds([start, end]), { padding: [54, 54], maxZoom: 15 });
  }

  function initMap() {
    if (!mapContainer || !hasCoordinates) return;
    mapContainer.hidden = false;
    if (map) {
      window.setTimeout(function () {
        map.invalidateSize();
        drawEndpoints();
      }, 30);
      return;
    }
    if (!window.L || !L.maplibreGL) {
      mapContainer.innerHTML = '<div class="map-fallback">The map library could not be loaded. Coordinates remain listed in the trip record.</div>';
      return;
    }

    map = L.map(mapContainer, {
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
    endpointLayer = L.layerGroup().addTo(map);
    drawEndpoints();
    window.setTimeout(function () { map.invalidateSize(); }, 240);
  }

  function updateCoordinatePanel() {
    var block = document.querySelector("[data-coordinate-block]");
    var empty = document.querySelector("[data-coordinate-empty]");
    var copy = document.querySelector("[data-coordinate-copy]");
    var origin = document.querySelector("[data-coordinate-origin]");
    var destination = document.querySelector("[data-coordinate-destination]");
    var tag = routeTag;

    if (hasCoordinates) {
      if (block) block.hidden = false;
      if (empty) empty.hidden = true;
      if (copy) {
        copy.hidden = false;
        copy.setAttribute("data-copy", formatPoint(trip.origin_coords));
      }
      if (origin) origin.textContent = formatPoint(trip.origin_coords);
      if (destination) destination.textContent = formatPoint(trip.destination_coords);
      if (tag) {
        tag.classList.remove("panel-tag--muted");
        tag.textContent = "Geocoded";
      }
      if (emptyPanel) emptyPanel.hidden = true;
      setStatus("", null);
      initMap();
    } else {
      if (block) block.hidden = true;
      if (empty) empty.hidden = false;
      if (copy) copy.hidden = true;
      if (tag) {
        tag.classList.add("panel-tag--muted");
        tag.textContent = "No coordinates";
      }
      if (emptyPanel) emptyPanel.hidden = false;
      if (mapContainer) mapContainer.hidden = true;
    }
  }

  if (mapContainer && hasCoordinates) {
    initMap();
  }

  var geocodeButtons = Array.prototype.slice.call(document.querySelectorAll("[data-geocode-trip]"));
  geocodeButtons.forEach(function (button) {
    button.addEventListener("click", async function () {
      if (button.disabled) return;
      var original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span><span>Looking up addresses…</span>';
      setStatus("Looking up the recorded origin and destination addresses…", "loading");
      try {
        var result = await window.GR.api("/api/trips/" + trip.id + "/geocode", {
          method: "POST"
        });
        if (result.trip) {
          Object.assign(trip, result.trip);
          hasCoordinates = Boolean(trip.has_coordinates);
        }
        var lookup = result.lookup || {};
        updateCoordinatePanel();
        if (lookup.status === "resolved") {
          window.GR.toast("Origin and destination resolved from the recorded addresses.");
        } else {
          setStatus(lookup.message || "The recorded addresses could not be resolved.", "error");
          window.GR.toast(lookup.message || "The recorded addresses could not be resolved.", "warn");
        }
      } catch (error) {
        setStatus(error.message || "The address lookup could not be completed.", "error");
        window.GR.toast(error.message || "The address lookup could not be completed.", "error");
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.innerHTML = original;
        }
      }
    });
  });
})();
