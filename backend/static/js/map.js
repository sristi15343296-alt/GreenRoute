/* Fleet map: recorded endpoints, filtering, inspector and route preview. */
(function () {
  "use strict";

  var shell = document.getElementById("map-shell");
  var dataNode = document.getElementById("fleet-map-data");
  if (!shell || !dataNode) return;

  var trips = [];
  try { trips = JSON.parse(dataNode.textContent) || []; } catch (error) { return; }

  var config = { center: { lat: 48.8566, lng: 2.3522, zoom: 11 }, geocoding: true, refresh: 0, units: "km" };
  try {
    var parsed = JSON.parse(shell.getAttribute("data-center") || "{}");
    config.center.lat = Number(parsed.lat) || config.center.lat;
    config.center.lng = Number(parsed.lng) || config.center.lng;
    config.center.zoom = Number(parsed.zoom) || config.center.zoom;
  } catch (error) { /* keep defaults */ }
  config.geocoding = shell.getAttribute("data-geocoding") === "1";
  config.refresh = Number(shell.getAttribute("data-refresh") || 0);
  config.units = shell.getAttribute("data-units") || "km";

  var STATUS_LABELS = {
    scheduled: "Scheduled",
    accepted: "Accepted",
    in_transit: "En route",
    on_scene: "On scene",
    completed: "Completed",
    cancelled: "Cancelled"
  };

  var OPEN_STATUSES = ["scheduled", "accepted", "in_transit", "on_scene"];

  var COORDINATE_LABELS = {
    missing: "No coordinates",
    missing_address: "No address",
    partial: "One endpoint only",
    resolved: "Located",
    ambiguous: "Ambiguous address",
    not_found: "Address not found",
    unavailable: "Lookup unavailable",
    rate_limited: "Lookup rate limited",
    invalid_response: "Invalid lookup result",
    invalid: "Invalid endpoints",
    error: "Lookup failed"
  };

  function coordinateLabel(trip) {
    if (trip.has_coordinates) return "Located";
    return COORDINATE_LABELS[trip.geocode_status] || "No coordinates";
  }

  var mapEl = document.getElementById("fleet-map");
  var listEl = document.getElementById("map-trip-list");
  var listCount = document.getElementById("map-list-count");
  var expandCount = document.getElementById("map-expand-count");
  var inspector = document.getElementById("map-inspector");
  var inspectorRef = document.getElementById("inspector-ref");
  var inspectorStatus = document.getElementById("inspector-status");
  var inspectorBody = document.getElementById("inspector-body");
  var listPanel = document.getElementById("map-list-panel");
  var expandButton = document.getElementById("map-expand");
  var layersButton = document.getElementById("map-layers");
  var layersPop = document.getElementById("map-layers-pop");

  var state = {
    status: "all",
    query: "",
    selected: null,
    routes: true,
    labels: true,
    map: null,
    markerLayer: null,
    lineLayer: null,
    previewLayer: null,
    selectedLayer: null,
    selectSeq: 0,
    lastSelectAt: 0
  };

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function distanceLabel(km) {
    if (km === null || km === undefined) return "—";
    var value = config.units === "mi" ? km * 0.621371 : km;
    return value.toFixed(1) + " " + config.units;
  }

  function durationLabel(minutes) {
    if (minutes === null || minutes === undefined) return "—";
    var total = Math.round(minutes);
    if (total < 60) return total + " min";
    var hours = Math.floor(total / 60);
    var rest = total % 60;
    return rest ? hours + "h " + rest + "m" : hours + "h";
  }

  function statusNode(trip) {
    var node = h("span", "status status--" + trip.status);
    node.appendChild(h("span", "status-dot"));
    node.appendChild(document.createTextNode(STATUS_LABELS[trip.status] || trip.status_label));
    return node;
  }

  function filtered() {
    var query = state.query.trim().toLowerCase();
    return trips.filter(function (trip) {
      var statusMatch = state.status === "all" || trip.status === state.status;
      var haystack = (trip.reference + " " + trip.origin + " " + trip.destination).toLowerCase();
      return statusMatch && (!query || haystack.indexOf(query) !== -1);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Map                                                                */
  /* ------------------------------------------------------------------ */

  function initMap() {
    if (!window.L || !L.maplibreGL) {
      mapEl.innerHTML = '<div class="map-fallback">The map library could not be loaded. Trip records remain available in the panel and the trips register.</div>';
      return;
    }
    state.map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 2,
      worldCopyJump: true
    }).setView([config.center.lat, config.center.lng], config.center.zoom);

    L.maplibreGL({
      style: "https://tiles.openfreemap.org/styles/dark",
      attributionControl: {
        customAttribution: '&copy; <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &middot; &copy; OpenMapTiles &middot; Data from OpenStreetMap'
      }
    }).addTo(state.map);

    // Phase C's live overlay attaches to this instance; exposing it keeps that
    // module out of this file's selection/refresh logic.
    window.GR.fleetMap = state.map;

    state.lineLayer = L.layerGroup().addTo(state.map);
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.selectedLayer = L.layerGroup().addTo(state.map);

    var zi = document.getElementById('map-zoom-in');
    var zo = document.getElementById('map-zoom-out');
    if (zi) zi.addEventListener('click', function(e){ e.stopPropagation(); }, true);
    if (zo) zo.addEventListener('click', function(e){ e.stopPropagation(); }, true);
    state.map.on("click", function (event) {
      // Only clear when clicking the map background. Ignore spurious clicks
      // that arrive immediately after a selection (marker/GL bridge races).
      if (Date.now() - state.lastSelectAt < 450) return;

      var oe = event && event.originalEvent ? event.originalEvent : null;
      var target = oe ? oe.target : null;
      var overlaySelector = ".leaflet-marker-icon, .leaflet-popup, .leaflet-control, .leaflet-control-container, .map-panel, .map-command, .map-tools, .map-layers-pop, .fleet-marker-wrap, .inspector-actions, .inspector-body, .map-zoom, [id^='map-zoom'], button[aria-label*='zoom' i], .leaflet-zoom-box";
      if (target && target.closest && target.closest(overlaySelector)) {
        return;
      }
      if (oe && typeof oe.clientX === "number" && typeof oe.clientY === "number" && document.elementsFromPoint) {
        var stack = document.elementsFromPoint(oe.clientX, oe.clientY);
        for (var i = 0; i < stack.length; i++) {
          var el = stack[i];
          if (el && el.matches && el.matches(overlaySelector)) return;
          if (el && el.closest && el.closest(overlaySelector)) return;
          if (el && el.id && (el.id === 'map-zoom-in' || el.id === 'map-zoom-out')) return;
          if (el === mapEl) break;
        }
      }
      closeInspector();
    });
    window.setTimeout(function () { state.map.invalidateSize(); }, 240);
  }

  function addTripMarker(trip, selected, layer) {
    var html = '<span class="fleet-marker fleet-marker--' + trip.status + (selected ? " is-selected" : "") + '"></span>';
    if (state.labels) {
      html += '<span class="fleet-label">' + window.GR.escapeHtml(trip.reference) + "</span>";
    }
    var marker = L.marker(trip.destination_coords, {
      icon: L.divIcon({
        className: "fleet-marker-wrap",
        html: html,
        iconSize: [0, 0],
        iconAnchor: [6, 6]
      }),
      title: trip.reference,
      riseOnHover: true
    });
    marker.on("click", function (event) {
      if (event && L.DomEvent) L.DomEvent.stopPropagation(event);
      if (event && event.originalEvent && L.DomEvent) L.DomEvent.stop(event.originalEvent);
      selectTrip(trip.id);
    });
    marker.bindTooltip(trip.reference + " · " + trip.destination, {
      className: "map-tooltip",
      direction: "top",
      offset: [0, -8]
    });
    marker.addTo(layer);
  }

  function drawSelectedRoute() {
    if (!state.map || !state.selectedLayer) return;
    state.selectedLayer.clearLayers();
    if (state.selected === null || state.selected === undefined) return;
    var trip = trips.find(function (item) { return item.id === state.selected; });
    if (!trip || !trip.has_coordinates) return;
    var start = trip.origin_coords;
    var end = trip.destination_coords;

    if (state.routes) {
      // The dark casing keeps the endpoint link legible over roads and
      // labels in the basemap. It links the recorded endpoints only.
      L.polyline([start, end], {
        color: "#080b10",
        weight: 8,
        opacity: 0.85,
        interactive: false
      }).addTo(state.selectedLayer);
      L.polyline([start, end], {
        color: "#c9f94c",
        weight: 2.8,
        opacity: 0.95,
        dashArray: "8 5",
        interactive: false
      }).addTo(state.selectedLayer);
    }

    L.circleMarker(start, {
      radius: 5.8,
      color: "#f0f3f6",
      weight: 1.8,
      fillColor: "#c9f94c",
      fillOpacity: 1,
      interactive: false
    }).bindTooltip("Origin · " + trip.reference, {
      permanent: true,
      direction: "top",
      offset: [0, -8],
      className: "map-tooltip"
    }).addTo(state.selectedLayer);
    L.circleMarker(end, {
      radius: 6.6,
      color: "#f0f3f6",
      weight: 2.2,
      fillColor: "#11161d",
      fillOpacity: 1,
      interactive: false
    }).bindTooltip("Destination · " + trip.reference, {
      permanent: true,
      direction: "bottom",
      offset: [0, 8],
      className: "map-tooltip"
    }).addTo(state.selectedLayer);

    addTripMarker(trip, true, state.selectedLayer);
  }

  function drawMap() {
    if (!state.map) return;
    state.markerLayer.clearLayers();
    state.lineLayer.clearLayers();

    filtered().forEach(function (trip) {
      if (!trip.has_coordinates) return;
      var start = trip.origin_coords;
      var end = trip.destination_coords;
      var selected = state.selected === trip.id;

      // Selected trip's route and marker are rendered by the persistent
      // selectedLayer so refreshes/filter redraws never clear it.
      if (selected) return;

      L.circleMarker(start, {
        radius: 2.6,
        color: "#77828f",
        weight: 1.2,
        fillColor: "#11161d",
        fillOpacity: 1,
        interactive: false
      }).addTo(state.markerLayer);

      if (state.routes) {
        L.polyline([start, end], {
          color: "rgba(167, 176, 188, 0.22)",
          weight: 1,
          dashArray: "3 4",
          interactive: false
        }).addTo(state.lineLayer);
      }

      addTripMarker(trip, false, state.markerLayer);
    });

    drawSelectedRoute();
  }

  function fitTo(list) {
    if (!state.map) return;
    var points = [];
    list.forEach(function (trip) {
      if (trip.has_coordinates) {
        points.push(trip.origin_coords);
        points.push(trip.destination_coords);
      }
    });
    if (points.length) {
      state.map.fitBounds(L.latLngBounds(points), { padding: [58, 58], maxZoom: 12 });
    } else {
      state.map.setView([config.center.lat, config.center.lng], config.center.zoom);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Trip list                                                          */
  /* ------------------------------------------------------------------ */

  function renderList() {
    var visible = filtered();
    if (listCount) listCount.textContent = String(visible.length);
    if (expandCount) expandCount.textContent = String(visible.length);
    if (!listEl) return;
    listEl.replaceChildren();

    if (!visible.length) {
      var empty = h("div", "map-empty");
      empty.appendChild(h("strong", null, trips.length ? "No trips match this filter" : "No trips recorded"));
      empty.appendChild(document.createTextNode(trips.length
        ? "Try another status or clear the search."
        : "Recorded trips with resolved addresses appear here."));
      listEl.appendChild(empty);
      return;
    }

    visible.forEach(function (trip) {
      var button = h("button", "map-trip" + (state.selected === trip.id ? " is-selected" : ""));
      button.type = "button";
      button.setAttribute("data-trip-id", String(trip.id));

      var top = h("div", "map-trip-top");
      top.appendChild(h("span", "map-trip-ref", trip.reference));
      var status = h("span", "map-trip-status");
      status.appendChild(h("i", "chip-dot chip-dot--" + trip.status));
      status.appendChild(document.createTextNode(STATUS_LABELS[trip.status] || trip.status_label));
      top.appendChild(status);

      var route = h("div", "map-trip-route");
      route.appendChild(h("span", null, trip.origin));
      route.appendChild(document.createTextNode(" → "));
      route.appendChild(h("span", null, trip.destination));

      var meta = h("div", "map-trip-meta");
      meta.appendChild(h("span", "mono", (trip.priority_label || trip.priority) + " · " + distanceLabel(trip.distance_km)));
      meta.appendChild(h("span", trip.has_coordinates ? null : "map-trip-flag", coordinateLabel(trip)));

      button.appendChild(top);
      button.appendChild(route);
      button.appendChild(meta);
      listEl.appendChild(button);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Inspector                                                          */
  /* ------------------------------------------------------------------ */

  function closeInspector(options) {
    if (!inspector) return;
    options = options || {};
    inspector.hidden = true;
    state.selected = null;
    state.selectSeq += 1;
    if (state.selectedLayer) state.selectedLayer.clearLayers();
    if (!options.skipRender) {
      renderList();
      drawMap();
    }
  }

  function openInspector(trip) {
    if (!inspector) return;
    inspector.hidden = false;
    inspectorRef.textContent = trip.reference;
    inspectorStatus.replaceChildren(statusNode(trip));
    inspectorBody.replaceChildren();

    var routeBox = h("div", "inspector-route");
    var stops = h("div", "inspector-od");

    function stop(label, value, end) {
      var row = h("div", "inspector-stop");
      row.appendChild(h("span", "inspector-stop-dot" + (end ? " inspector-stop-dot--end" : "")));
      var copy = h("div");
      copy.appendChild(h("span", null, label));
      copy.appendChild(h("b", null, value));
      row.appendChild(copy);
      stops.appendChild(row);
    }
    stop("Origin", trip.origin, false);
    stop("Destination", trip.destination, true);
    routeBox.appendChild(stops);

    var meta = h("div", "inspector-meta");
    function kv(label, value) {
      var cell = h("div", "inspector-kv");
      cell.appendChild(h("span", null, label));
      cell.appendChild(h("b", null, value));
      meta.appendChild(cell);
    }
    kv("Distance", distanceLabel(trip.distance_km));
    kv("Est. duration", durationLabel(trip.duration_min));
    kv("Priority", trip.priority_label || trip.priority);
    kv("Recorded", (trip.created_at || "").replace("T", " ").slice(0, 16) + " UTC");
    routeBox.appendChild(meta);
    inspectorBody.appendChild(routeBox);

    var actions = h("div", "inspector-actions");
    var details = h("a", "btn btn-primary btn-sm", "Open details");
    details.href = trip.url;
    actions.appendChild(details);

    if (trip.status === "scheduled") {
      actions.appendChild(actionButton("start", trip.id, "Mark en route"));
    } else if (trip.status === "accepted") {
      actions.appendChild(actionButton("depart", trip.id, "Mark en route"));
    } else if (trip.status === "in_transit") {
      actions.appendChild(actionButton("arrive", trip.id, "Mark on scene"));
    } else if (trip.status === "on_scene") {
      actions.appendChild(actionButton("complete", trip.id, "Complete response"));
    }
    if (OPEN_STATUSES.indexOf(trip.status) !== -1) {
      actions.appendChild(actionButton("cancel", trip.id, "Cancel"));
    }
    inspectorBody.appendChild(actions);

    var lookup = h("div", "inspector-section");
    lookup.appendChild(h("h4", null, "Map coordinates"));
    if (trip.has_coordinates) {
      lookup.appendChild(h("p", "inspector-note", "Origin and destination resolved from the recorded addresses. The selected line is an endpoint link, not a driven path."));
    } else {
      var status = h("p", "inspector-note inspector-note--status", coordinateLabel(trip));
      if (trip.geocode_message) {
        status.textContent += " — " + trip.geocode_message;
      }
      lookup.appendChild(status);
      if (config.geocoding) {
        var geocodeButton = h("button", "btn btn-secondary btn-sm btn-block", "Look up addresses");
        geocodeButton.type = "button";
        geocodeButton.setAttribute("data-geocode-trip", String(trip.id));
        lookup.appendChild(geocodeButton);
      } else {
        var disabled = h("button", "btn btn-secondary btn-sm btn-block", "Address lookup disabled");
        disabled.type = "button";
        disabled.disabled = true;
        lookup.appendChild(disabled);
      }
      lookup.appendChild(h("p", "inspector-note", "Coordinates are resolved from the recorded addresses and saved for later visits. No vehicle is tracked."));
    }
    inspectorBody.appendChild(lookup);

    var note = h("p", "inspector-note", "Recorded data only. The line links the two recorded endpoints; it is not live GPS or a verified driven path.");
    inspectorBody.appendChild(note);

    if (window.innerWidth < 900) setListCollapsed(true);
  }

  function actionButton(action, tripId, label) {
    var button = h("button", "btn " + (action === "cancel" ? "btn-secondary" : "btn-primary") + " btn-sm", label);
    button.type = "button";
    button.setAttribute("data-trip-action", action);
    button.setAttribute("data-trip-id", String(tripId));
    return button;
  }

  function selectTrip(id) {
    var trip = trips.find(function (item) { return item.id === id; });
    if (!trip) { closeInspector(); return; }
    state.selectSeq += 1;
    state.lastSelectAt = Date.now();
    state.selected = id;
    renderList();
    drawMap();
    openInspector(trip);
    if (trip.has_coordinates && state.map) {
      window.requestAnimationFrame(function () {
        if (state.selected !== id || !state.map) return;
        state.map.invalidateSize();
        state.map.fitBounds(L.latLngBounds([trip.origin_coords, trip.destination_coords]), {
          padding: [90, 90],
          maxZoom: 15
        });
      });
    } else if (state.map) {
      window.requestAnimationFrame(function () { if (state.map) state.map.invalidateSize(); });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Panels and controls                                                */
  /* ------------------------------------------------------------------ */



  function setListCollapsed(collapsed) {
    listPanel.classList.toggle("is-collapsed", collapsed);
    expandButton.hidden = !collapsed;
    shell.classList.toggle("list-collapsed", collapsed);
    if (state.map) {
      window.setTimeout(function () { if (state.map) state.map.invalidateSize(); }, 180);
    }
  }

  document.getElementById("map-collapse").addEventListener("click", function () { setListCollapsed(true); });
  expandButton.addEventListener("click", function () { setListCollapsed(false); });
  document.getElementById("inspector-close").addEventListener("click", closeInspector);
  document.getElementById("map-fit").addEventListener("click", function () { fitTo(filtered()); });

  document.getElementById("map-zoom-in").addEventListener("click", function () {
    if (state.map) state.map.zoomIn();
  });
  document.getElementById("map-zoom-out").addEventListener("click", function () {
    if (state.map) state.map.zoomOut();
  });
  document.getElementById("map-recenter").addEventListener("click", function () {
    if (state.map) state.map.setView([config.center.lat, config.center.lng], config.center.zoom);
  });

  layersButton.addEventListener("click", function (event) {
    event.stopPropagation();
    var open = layersPop.hidden;
    layersPop.hidden = !open;
    layersButton.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", function (event) {
    if (!event.target.closest("#map-layers-pop") && !event.target.closest("#map-layers")) {
      layersPop.hidden = true;
      layersButton.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      layersPop.hidden = true;
    }
  });

  document.getElementById("layer-routes").addEventListener("change", function (event) {
    state.routes = event.target.checked;
    drawMap();
  });
  document.getElementById("layer-labels").addEventListener("change", function (event) {
    state.labels = event.target.checked;
    drawMap();
  });

  document.querySelectorAll("[data-map-status]").forEach(function (button) {
    button.addEventListener("click", function () {
      state.status = button.getAttribute("data-map-status");
      document.querySelectorAll("[data-map-status]").forEach(function (item) {
        item.classList.toggle("is-on", item === button);
      });
      renderList();
      drawMap();
      fitTo(filtered());
    });
  });

  listEl.addEventListener("click", function (event) {
    var button = event.target.closest("[data-trip-id]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    selectTrip(Number(button.getAttribute("data-trip-id")));
  });

  var search = document.getElementById("map-search");
  var searchTimer = null;
  search.addEventListener("input", function () {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      state.query = search.value;
      renderList();
      drawMap();
    }, 200);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    event.preventDefault();
    search.focus();
    search.select();
  });

  /* ------------------------------------------------------------------ */
  /* Geocode a trip from the inspector                                  */
  /* ------------------------------------------------------------------ */

  inspector.addEventListener("click", async function (event) {
    var button = event.target.closest("[data-geocode-trip]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    var id = Number(button.getAttribute("data-geocode-trip"));
    var trip = trips.find(function (item) { return item.id === id; });
    if (!trip) return;

    var original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span><span>Resolving addresses…</span>';
    try {
      var result = await window.GR.api("/api/trips/" + id + "/geocode", {
        method: "POST"
      });
      trips = trips.map(function (item) {
        if (item.id === id) {
          var merged = result.trip;
          merged.url = "/trips/" + id;
          return merged;
        }
        return item;
      });
      var lookup = result.lookup || {};
      if (lookup.status === "resolved") {
        window.GR.toast("Origin and destination resolved from the recorded addresses.");
      } else {
        window.GR.toast(lookup.message || "The recorded addresses could not be resolved.", "warn");
      }
      selectTrip(id);
    } catch (error) {
      window.GR.toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = original;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Route preview tool                                                 */
  /* ------------------------------------------------------------------ */

  var previewForm = document.getElementById("route-preview-form");
  var previewResult = document.getElementById("route-result");
  if (previewForm) {
    previewForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var errorField = previewForm.querySelector("[data-form-error]");
      var submit = previewForm.querySelector('[type="submit"]');
      errorField.hidden = true;
      if (!previewForm.reportValidity()) return;

      var origin = previewForm.elements.origin.value.trim();
      var destination = previewForm.elements.destination.value.trim();
      if (!origin || !destination) return;

      window.GR.setLoading(submit, true);
      previewResult.textContent = "Resolving addresses and calculating the route…";

      try {
        var route = await window.GR.resolveRoute(origin, destination);
        if (!state.map) throw new Error("The map is unavailable, so the preview cannot be drawn.");

        if (state.previewLayer) {
          state.map.removeLayer(state.previewLayer);
          state.previewLayer = null;
        }
        state.previewLayer = L.layerGroup().addTo(state.map);
        L.polyline(route.geometry, {
          color: "#a8b2be",
          weight: 2.4,
          opacity: 0.9
        }).addTo(state.previewLayer);
        L.circleMarker([route.origin_lat, route.origin_lng], {
          radius: 4.5,
          color: "#a8b2be",
          weight: 1.4,
          fillColor: "#11161d",
          fillOpacity: 1
        }).addTo(state.previewLayer);
        L.circleMarker([route.destination_lat, route.destination_lng], {
          radius: 5.5,
          color: "#f0f3f6",
          weight: 1.6,
          fillColor: "#f0f3f6",
          fillOpacity: 1
        }).addTo(state.previewLayer);
        state.map.fitBounds(L.latLngBounds(route.geometry), { padding: [40, 40], maxZoom: 12 });

        var distance = config.units === "mi" ? route.distance_km * 0.621371 : route.distance_km;
        previewResult.textContent = "Estimated " + distance.toFixed(1) + " " + config.units +
          " · " + durationLabel(route.duration_min) + ". Public routing estimate, not live traffic.";
      } catch (error) {
        previewResult.textContent = "";
        errorField.textContent = error.message;
        errorField.hidden = false;
      } finally {
        window.GR.setLoading(submit, false);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Refresh polling (recorded data only)                               */
  /* ------------------------------------------------------------------ */

  async function refreshTrips() {
    try {
      var result = await window.GR.api("/api/trips");
      trips = result.trips || [];
      var selectedId = state.selected;
      if (selectedId !== null && selectedId !== undefined && !trips.some(function (trip) { return trip.id === selectedId; })) {
        closeInspector({ skipRender: true });
      }
      renderList();
      drawMap();
      // drawSelectedRoute() is called by drawMap(); this keeps the selected
      // endpoint route visible across recorded-data refreshes.
      var stamp = document.querySelector(".map-footnote span:first-child");
      if (stamp) {
        var now = new Date();
        stamp.textContent = "Refreshed " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    } catch (error) {
      /* Keep the last known records if a refresh fails. */
    }
  }

  initMap();
  renderList();
  drawMap();
  fitTo(filtered());
  if (config.refresh > 0) window.setInterval(refreshTrips, config.refresh * 1000);
})();
