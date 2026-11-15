/* Create emergency response: itinerary builder, route preview, draft and submit. */
(function () {
  "use strict";

  var page = document.querySelector(".create-page");
  var form = document.getElementById("response-create-form");
  if (!page || !form) return;

  var GR = window.GR || {};
  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var escapeHtml = GR.escapeHtml || function (value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  };

  var typeField = document.getElementById("response-emergency-type");
  var priorityField = document.getElementById("response-priority");
  var waypointsField = document.getElementById("response-waypoints");
  var nameField = document.getElementById("response-name");
  var originField = document.getElementById("response-origin");
  var destinationField = document.getElementById("response-destination");
  var dispatchField = document.getElementById("response-dispatch");
  var statusField = document.getElementById("response-status");
  var statusExplicitField = document.getElementById("status-explicit");
  var instructionsField = document.getElementById("response-instructions");
  var notesField = document.getElementById("response-notes");
  var vehicleSelect = document.getElementById("response-vehicle");
  var vehicleAvailability = $("[data-vehicle-availability]");
  var vehicleDetail = $("[data-vehicle-detail]");
  var crewList = $("[data-crew-list]");
  var crewAvailability = $("[data-crew-availability]");
  var crewCount = $("[data-crew-count]");
  var summaryVehicle = $("[data-summary-vehicle]");
  var summaryCrew = $("[data-summary-crew]");
  var distanceValue = document.getElementById("response-distance-value");
  var durationValue = document.getElementById("response-duration-value");
  var distanceField = document.getElementById("response-distance");
  var durationField = document.getElementById("response-duration");
  var waypointsContainer = document.getElementById("intermediate-stops");
  var addStopButton = document.getElementById("add-stop");
  var stopCount = document.getElementById("stop-count");
  var summaryWaypoints = $("[data-summary-waypoints]");
  var clientError = document.getElementById("create-client-error");
  var clientErrorMessage = $("[data-client-error-message]", clientError);
  var draftKey = page.getAttribute("data-draft-key") || "gr-response-draft-v1";
  var geocodingEnabled = form.getAttribute("data-geocoding") === "1";
  var distanceUnit = form.getAttribute("data-distance-unit") || "km";
  var hasServerErrors = page.getAttribute("data-has-errors") === "1";
  var dirty = false;
  var submitting = false;
  var map = null;
  var markersLayer = null;
  var routeLine = null;
  var routeGlow = null;
  var routeBounds = null;
  var routeState = null;
  var routeToken = 0;
  var locationSelections = { origin: null, destination: null };
  var autosaveTimer = null;
  var routeTimer = null;

  /* ------------------------------------------------------------------ */
  /* Formatting                                                         */
  /* ------------------------------------------------------------------ */

  function unitFactor() {
    return distanceUnit === "mi" ? 0.621371 : 1;
  }

  function formatDistance(km) {
    if (km === null || km === undefined) return "—";
    return (Number(km) * unitFactor()).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " " + distanceUnit;
  }

  function formatDuration(minutes) {
    if (minutes === null || minutes === undefined) return "—";
    var mins = Math.max(1, Math.round(Number(minutes)));
    var hours = Math.floor(mins / 60);
    var rest = mins % 60;
    if (!hours) return mins + " min";
    return hours + "h " + String(rest).padStart(2, "0") + "m";
  }

  function formatDispatch(value) {
    if (!value) return "—";
    var raw = String(value);
    if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) raw += "Z";
    var date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).replace(",", " ·") + " UTC";
  }

  function statusLabel(value) {
    return value === "scheduled" ? "Scheduled" : "En route";
  }

  /* ------------------------------------------------------------------ */
  /* Summary                                                            */
  /* ------------------------------------------------------------------ */

  var summaryName = $("[data-summary-name]");
  var summaryType = $("[data-summary-type]");
  var summaryPriority = $("[data-summary-priority]");
  var summaryDispatch = $("[data-summary-dispatch]");
  var summaryStatus = $("[data-summary-status]");
  var summaryOrigin = $("[data-summary-origin]");
  var summaryDestination = $("[data-summary-destination]");
  var summaryDistance = $("[data-summary-distance]");
  var summaryDuration = $("[data-summary-duration]");
  var summaryStops = $("[data-summary-stops]");
  var summaryPriorityStat = $("[data-summary-priority-stat]");
  var completeness = $("[data-completeness]");

  function setSummaryText(node, value, emptyText) {
    if (!node) return;
    node.textContent = value || emptyText;
    node.classList.toggle("is-empty", !value);
  }

  function typeLabel() {
    var item = $('[data-dropdown-value="' + typeField.value + '"]');
    return item ? item.getAttribute("data-label") : "";
  }

  function priorityLabel() {
    var item = $('[data-chip-value="' + priorityField.value + '"]');
    return item ? item.textContent.trim() : "";
  }

  function waypointNames() {
    return $$("[data-waypoint] input", waypointsContainer).map(function (input) {
      return input.value.trim();
    }).filter(Boolean);
  }

  function updateWaypointSummary() {
    if (!summaryWaypoints) return;
    summaryWaypoints.replaceChildren();
    waypointNames().forEach(function (name) {
      var row = document.createElement("div");
      row.className = "create-summary-stop";
      row.innerHTML = '<span class="bar"><i class="d m"></i><i class="l"></i></span><span class="n"></span>';
      $(".n", row).textContent = name;
      summaryWaypoints.appendChild(row);
    });
  }

  function updateSummary() {
    setSummaryText(summaryName, nameField.value.trim(), "Not named yet");
    setSummaryText(summaryType, typeLabel(), "Not selected");
    if (summaryPriority) summaryPriority.textContent = priorityLabel() || "—";
    if (summaryPriorityStat) summaryPriorityStat.textContent = priorityLabel() || "—";
    if (summaryDispatch) summaryDispatch.textContent = formatDispatch(dispatchField.value);
    if (summaryStatus) summaryStatus.textContent = statusLabel(statusField.value);
    if (summaryVehicle) {
      var vehicleOption = vehicleSelect && vehicleSelect.selectedIndex >= 0 ? vehicleSelect.options[vehicleSelect.selectedIndex] : null;
      setSummaryText(summaryVehicle, vehicleOption && vehicleSelect.value ? (vehicleOption.getAttribute("data-label") || vehicleOption.textContent.trim()) : "", "Unassigned");
    }
    if (summaryCrew) {
      var crew = crewNames();
      setSummaryText(summaryCrew, crew.length ? crew.join(", ") : "", "Unassigned");
    }
    if (crewCount) crewCount.textContent = crewNames().length + " selected";
    setSummaryText(summaryOrigin, originField.value.trim(), "Incident location not set");
    setSummaryText(summaryDestination, destinationField.value.trim(), "Response destination not set");
    if (summaryDistance) summaryDistance.textContent = formatDistance(routeState ? routeState.distance_km : null);
    if (summaryDuration) summaryDuration.textContent = formatDuration(routeState ? routeState.duration_min : null);
    if (summaryStops) summaryStops.textContent = String(waypointNames().length + 2);
    if (stopCount) stopCount.textContent = String(waypointNames().length + 2);
    var routeStops = $("[data-route-stops]");
    if (routeStops) routeStops.textContent = String(waypointNames().length + 2);
    updateWaypointSummary();
    updateCompleteness();
  }

  function updateCompleteness() {
    if (!completeness) return;
    var required = [
      nameField.value.trim(),
      typeField.value,
      originField.value.trim(),
      destinationField.value.trim(),
      dispatchField.value,
      priorityField.value
    ];
    var missing = required.filter(function (value) { return !value; }).length;
    completeness.textContent = missing ? missing + " required field" + (missing === 1 ? "" : "s") + " remaining" : "All required fields complete";
  }

  /* ------------------------------------------------------------------ */
  /* Resource availability                                             */
  /* ------------------------------------------------------------------ */

  var resourceTimer = null;

  function selectedCrewIds() {
    if (!crewList) return [];
    return $$('input[name="crew_ids"]:checked', crewList).map(function (input) {
      return input.value;
    });
  }

  function crewNames() {
    if (!crewList) return [];
    return $$('input[name="crew_ids"]:checked', crewList).map(function (input) {
      var option = input.closest(".create-crew-option");
      var name = option ? $(".create-crew-copy strong", option) : null;
      return name ? name.textContent.trim() : "";
    }).filter(Boolean);
  }

  function syncVehicleDetail() {
    if (!vehicleSelect || !vehicleDetail) return;
    var option = vehicleSelect.selectedIndex >= 0 ? vehicleSelect.options[vehicleSelect.selectedIndex] : null;
    if (!option || !vehicleSelect.value) {
      vehicleDetail.textContent = vehicleSelect.options.length > 1
        ? "Select an available unit for this response."
        : "No vehicles are registered in this workspace.";
      return;
    }
    vehicleDetail.textContent = (option.getAttribute("data-label") || option.textContent.trim()) + " assigned.";
  }

  function renderResources(data, previousVehicle, previousCrew) {
    if (vehicleSelect) {
      vehicleSelect.replaceChildren();
      var blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "No vehicle assigned";
      vehicleSelect.appendChild(blank);
      (data.vehicles || []).forEach(function (vehicle) {
        var option = document.createElement("option");
        option.value = String(vehicle.id);
        option.disabled = !vehicle.available;
        option.setAttribute("data-label", vehicle.call_sign + " · " + vehicle.type_label);
        option.textContent = vehicle.call_sign + " · " + vehicle.type_label +
          (vehicle.base_location ? " · " + vehicle.base_location : "") +
          (vehicle.available ? "" : " — " + vehicle.reason);
        vehicleSelect.appendChild(option);
      });
      var keepVehicle = previousVehicle && $$("option", vehicleSelect).some(function (option) {
        return option.value === previousVehicle && !option.disabled;
      });
      vehicleSelect.value = keepVehicle ? previousVehicle : "";
      if (vehicleAvailability) {
        vehicleAvailability.textContent = (data.available_vehicles || 0) + " available";
      }
      if (previousVehicle && !keepVehicle && GR.toast) {
        GR.toast("The selected vehicle is no longer available for this window.", "error");
      }
    }

    if (crewList) {
      crewList.replaceChildren();
      (data.personnel || []).forEach(function (member) {
        var label = document.createElement("label");
        label.className = "create-crew-option" + (member.available ? "" : " is-unavailable");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.name = "crew_ids";
        input.value = String(member.id);
        input.disabled = !member.available;
        input.checked = member.available && previousCrew.indexOf(String(member.id)) >= 0;
        var copy = document.createElement("span");
        copy.className = "create-crew-copy";
        var name = document.createElement("strong");
        name.textContent = member.name;
        var meta = document.createElement("span");
        meta.textContent = member.role_label + " · " + member.employee_id;
        copy.append(name, meta);
        if (!member.available) {
          var reason = document.createElement("em");
          reason.textContent = member.reason;
          copy.appendChild(reason);
        }
        label.append(input, copy);
        crewList.appendChild(label);
      });
      if (crewAvailability) {
        crewAvailability.textContent = (data.available_personnel || 0) + " available";
      }
      if (crewCount) crewCount.textContent = selectedCrewIds().length + " selected";
    }
    syncVehicleDetail();
    updateSummary();
  }

  async function refreshResources() {
    if (!vehicleSelect && !crewList) return;
    if (!dispatchField.value) return;
    var previousVehicle = vehicleSelect ? vehicleSelect.value : "";
    var previousCrew = selectedCrewIds();
    var params = new URLSearchParams({ dispatch_at: dispatchField.value });
    if (routeState && routeState.duration_min) params.set("duration_min", routeState.duration_min);
    if (typeField.value) params.set("emergency_type", typeField.value);
    if (vehicleAvailability) vehicleAvailability.textContent = "Checking…";
    if (crewAvailability) crewAvailability.textContent = "Checking…";
    try {
      var response = await fetch("/api/resources/availability?" + params.toString(), {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("Availability could not be checked.");
      renderResources(await response.json(), previousVehicle, previousCrew);
    } catch (error) {
      if (vehicleAvailability) vehicleAvailability.textContent = "Check unavailable";
      if (crewAvailability) crewAvailability.textContent = "Check unavailable";
    }
  }

  function scheduleResourceRefresh() {
    window.clearTimeout(resourceTimer);
    resourceTimer = window.setTimeout(refreshResources, 300);
  }

  if (vehicleSelect) {
    vehicleSelect.addEventListener("change", function () {
      // Assigning a unit does not dispatch it. Unless the operator has chosen a
      // starting state deliberately, a crewed response starts scheduled.
      if (vehicleSelect.value && statusField && !(statusExplicitField && statusExplicitField.value === "1")) {
        statusField.value = "scheduled";
      }
      syncVehicleDetail();
      updateSummary();
      markDirty();
    });
  }

  if (crewList) {
    crewList.addEventListener("change", function (event) {
      var input = event.target.closest('input[name="crew_ids"]');
      if (!input) return;
      if (selectedCrewIds().length > 4) {
        input.checked = false;
        if (GR.toast) GR.toast("Assign no more than four responders to one response.", "error");
      }
      updateSummary();
      markDirty();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Emergency type dropdown                                            */
  /* ------------------------------------------------------------------ */

  var dropdown = $("[data-dropdown]", form);
  var trigger = $("[data-dropdown-trigger]", dropdown);
  var menu = $("[data-dropdown-menu]", dropdown);
  var dropdownLabel = $("[data-dropdown-label]", dropdown);
  var dropdownDot = $("[data-dropdown-dot]", dropdown);
  var dropdownSearch = $("[data-dropdown-search]", dropdown);

  function closeDropdown() {
    if (!menu || !trigger) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  function openDropdown() {
    if (!menu || !trigger) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (dropdownSearch) {
      dropdownSearch.value = "";
      $$(".create-dropdown-item", menu).forEach(function (item) { item.hidden = false; });
      window.setTimeout(function () { dropdownSearch.focus(); }, 30);
    }
  }

  function setType(value, focus) {
    var item = $('[data-dropdown-value="' + value + '"]', menu);
    typeField.value = item ? value : "";
    if (dropdownLabel) {
      dropdownLabel.textContent = item ? item.getAttribute("data-label") : "Select emergency type";
    }
    if (dropdownDot) {
      var dot = item ? $(".status-dot", item) : null;
      dropdownDot.className = "status-dot " + (dot ? dot.className.replace("status-dot", "").trim() : "status-dot--gray");
    }
    $$(".create-dropdown-item", menu).forEach(function (entry) {
      var selected = entry === item;
      entry.classList.toggle("is-selected", selected);
      entry.setAttribute("aria-selected", selected ? "true" : "false");
    });
    if (focus) trigger.focus();
    updateSummary();
    scheduleResourceRefresh();
    markDirty();
  }

  if (trigger && menu) {
    trigger.addEventListener("click", function (event) {
      event.stopPropagation();
      if (menu.hidden) openDropdown();
      else closeDropdown();
    });
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" && menu.hidden) {
        event.preventDefault();
        openDropdown();
      }
    });
    menu.addEventListener("click", function (event) {
      var item = event.target.closest("[data-dropdown-value]");
      if (!item) return;
      event.stopPropagation();
      setType(item.getAttribute("data-dropdown-value"), true);
      closeDropdown();
    });
    menu.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDropdown();
        trigger.focus();
      }
    });
    document.addEventListener("click", function (event) {
      if (!dropdown.contains(event.target)) closeDropdown();
    });
    if (dropdownSearch) {
      dropdownSearch.addEventListener("input", function () {
        var query = dropdownSearch.value.trim().toLowerCase();
        $$(".create-dropdown-item", menu).forEach(function (item) {
          item.hidden = query && !item.textContent.toLowerCase().includes(query);
        });
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Priority                                                           */
  /* ------------------------------------------------------------------ */

  var chips = $("[data-chips]", form);
  function setPriority(value) {
    priorityField.value = value;
    $$("[data-chip-value]", chips).forEach(function (chip) {
      var selected = chip.getAttribute("data-chip-value") === value;
      chip.classList.toggle("is-selected", selected);
      chip.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    updateSummary();
    markDirty();
  }
  if (chips) {
    chips.addEventListener("click", function (event) {
      var chip = event.target.closest("[data-chip-value]");
      if (chip) setPriority(chip.getAttribute("data-chip-value"));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Intermediate stops                                                 */
  /* ------------------------------------------------------------------ */

  function syncWaypoints(invalidate) {
    var names = waypointNames();
    waypointsField.value = JSON.stringify(names);
    $$("[data-waypoint]", waypointsContainer).forEach(function (card, index) {
      var marker = $(".create-stop-marker", card);
      if (marker) marker.textContent = String(index + 1);
      var label = $("[data-waypoint-label]", card);
      if (label) label.textContent = "Intermediate stop " + (index + 1);
    });
    if (addStopButton) {
      addStopButton.disabled = names.length >= 4;
      addStopButton.innerHTML = names.length >= 4
        ? "Maximum of four intermediate stops"
        : '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Add intermediate stop';
    }
    updateSummary();
    if (invalidate) invalidateRoute("Route stops changed — recalculate the route.");
  }

  function createWaypointCard(name) {
    var card = document.createElement("div");
    card.className = "create-stop";
    card.setAttribute("data-waypoint", "");
    card.innerHTML =
      '<div class="create-stop-rail"><span class="create-stop-marker mid"></span><span class="create-stop-line"></span></div>' +
      '<div class="create-stop-content"><div class="create-stop-label" data-waypoint-label>Intermediate stop</div>' +
      '<input class="create-input create-waypoint-input" type="text" maxlength="120" placeholder="Intermediate location" aria-label="Intermediate stop"></div>' +
      '<div class="create-stop-actions">' +
      '<button class="create-stop-btn" type="button" title="Move stop up" data-waypoint-up aria-label="Move stop up"><svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>' +
      '<button class="create-stop-btn" type="button" title="Move stop down" data-waypoint-down aria-label="Move stop down"><svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
      '<button class="create-stop-btn" type="button" title="Remove stop" data-waypoint-remove aria-label="Remove stop"><svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>' +
      "</div>";
    var input = $("input", card);
    input.value = name || "";
    return card;
  }

  function decorateWaypoint(card) {
    var actions = $(".create-stop-actions", card);
    if (!actions || $("[data-waypoint-up]", actions)) return;
    actions.insertAdjacentHTML("afterbegin",
      '<button class="create-stop-btn" type="button" title="Move stop up" data-waypoint-up aria-label="Move stop up"><svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>' +
      '<button class="create-stop-btn" type="button" title="Move stop down" data-waypoint-down aria-label="Move stop down"><svg class="icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>');
  }

  if (waypointsContainer) {
    var initialWaypoints = $$("[data-waypoint] input", waypointsContainer).map(function (input) { return input.value; });
    waypointsContainer.replaceChildren();
    initialWaypoints.forEach(function (name) {
      waypointsContainer.appendChild(createWaypointCard(name));
    });

    waypointsContainer.addEventListener("input", function (event) {
      if (!event.target.matches("[data-waypoint] input")) return;
      syncWaypoints(true);
      markDirty();
    });

    waypointsContainer.addEventListener("click", function (event) {
      var card = event.target.closest("[data-waypoint]");
      if (!card) return;
      if (event.target.closest("[data-waypoint-remove]")) {
        card.remove();
        syncWaypoints(true);
        markDirty();
      } else if (event.target.closest("[data-waypoint-up]")) {
        var previous = card.previousElementSibling;
        if (previous && previous.hasAttribute("data-waypoint")) {
          waypointsContainer.insertBefore(card, previous);
          syncWaypoints(true);
          markDirty();
        }
      } else if (event.target.closest("[data-waypoint-down]")) {
        var next = card.nextElementSibling;
        if (next && next.hasAttribute("data-waypoint")) {
          waypointsContainer.insertBefore(next, card);
          syncWaypoints(true);
          markDirty();
        }
      }
    });
  }

  if (addStopButton) {
    addStopButton.addEventListener("click", function () {
      if (waypointNames().length >= 4) return;
      var card = createWaypointCard("");
      waypointsContainer.appendChild(card);
      syncWaypoints(false);
      var input = $("input", card);
      if (input) input.focus();
      markDirty();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Map and route                                                      */
  /* ------------------------------------------------------------------ */

  var mapElement = document.getElementById("response-map");
  var mapWrap = document.getElementById("create-map-wrap");
  var mapStatus = $("[data-route-status]");
  var calculateButton = document.getElementById("calculate-route");
  var fitButton = document.getElementById("fit-route");
  var fullscreenButton = document.getElementById("fullscreen-map");

  function setRouteStatus(message, tone) {
    if (!mapStatus) return;
    mapStatus.textContent = message;
    mapStatus.classList.remove("is-error", "is-loading");
    if (tone) mapStatus.classList.add(tone);
  }

  function initMap() {
    if (!mapElement || typeof window.L === "undefined" || !L.maplibreGL) {
      setRouteStatus("Map preview could not load. Route estimates still work when the routing service is available.", "is-error");
      return;
    }
    var lat = Number(mapElement.getAttribute("data-lat")) || 20.5937;
    var lng = Number(mapElement.getAttribute("data-lng")) || 78.9629;
    var zoom = Number(mapElement.getAttribute("data-zoom")) || 5;
    map = L.map(mapElement, {
      center: [lat, lng],
      zoom: zoom,
      zoomControl: false,
      attributionControl: true
    });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.maplibreGL({
      style: "https://tiles.openfreemap.org/styles/dark",
      attributionControl: {
        customAttribution: '&copy; <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &middot; &copy; OpenMapTiles &middot; Data from OpenStreetMap'
      }
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  function clearRouteLayers() {
    routeBounds = null;
    if (!map) return;
    markersLayer.clearLayers();
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (routeGlow) { map.removeLayer(routeGlow); routeGlow = null; }
  }

  function invalidateRoute(message) {
    if (!routeState) return;
    routeState = null;
    distanceValue.value = "";
    durationValue.value = "";
    distanceField.value = "—";
    durationField.value = "—";
    if (summaryDistance) summaryDistance.textContent = "—";
    if (summaryDuration) summaryDuration.textContent = "—";
    clearRouteLayers();
    if (message) setRouteStatus(message);
  }

  function markerIcon(kind, label) {
    return L.divIcon({
      className: "",
      html: '<div class="create-pin ' + kind + '">' + escapeHtml(label) + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function drawRoute(points, geometry) {
    clearRouteLayers();
    var latLngs = geometry.map(function (point) { return [point[0], point[1]]; });
    routeLine = L.polyline(latLngs, {
      color: "#a8b2be", weight: 3.2, opacity: 0.95, lineJoin: "round", dashArray: "7 5"
    }).addTo(map);
    points.forEach(function (point, index) {
      var kind = index === 0 ? "origin" : (index === points.length - 1 ? "dest" : "mid");
      var label = index === 0 ? "A" : (index === points.length - 1 ? "B" : String(index));
      L.marker([point.lat, point.lng], { icon: markerIcon(kind, label) })
        .bindTooltip(point.name, { direction: "top", offset: [0, -12] })
        .addTo(markersLayer);
    });
    routeBounds = L.latLngBounds(latLngs);
    map.fitBounds(routeBounds, { padding: [38, 38] });
  }

  function setLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> ' + (label || "Working…");
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  function routePoints() {
    var origin = originField.value.trim();
    var destination = destinationField.value.trim();
    if (!origin || !destination) return null;
    var stops = waypointNames();
    return [origin].concat(stops, [destination]);
  }

  async function calculateRoute(options) {
    options = options || {};
    if (!geocodingEnabled) {
      if (!options.silent) {
        setRouteStatus("Address lookup is disabled in Settings. Save without a route estimate.", "is-error");
        if (GR.toast) GR.toast("Enable address lookup in Settings to calculate routes.", "error");
      }
      return null;
    }
    var names = routePoints();
    if (!names) {
      if (!options.silent) {
        setRouteStatus("Enter the incident location and response destination first.", "is-error");
        originField.focus();
      }
      return null;
    }
    var emptyStop = $$("[data-waypoint] input", waypointsContainer).some(function (input) {
      return !input.value.trim();
    });
    if (emptyStop) {
      if (!options.silent) {
        setRouteStatus("Name or remove each intermediate stop before calculating.", "is-error");
        if (GR.toast) GR.toast("Name or remove each intermediate stop.", "error");
      }
      return null;
    }
    if (names.length > 6) {
      setRouteStatus("Too many stops for one route.", "is-error");
      return null;
    }

    var token = ++routeToken;
    setLoading(calculateButton, true, "Calculating…");
    setRouteStatus("Looking up addresses and the driving route…", "is-loading");
    try {
      var points = [];
      for (var index = 0; index < names.length; index += 1) {
        var selectedLocation = index === 0
          ? currentLocationSelection("origin")
          : (index === names.length - 1 ? currentLocationSelection("destination") : null);
        if (selectedLocation) {
          points.push({
            lat: Number(selectedLocation.lat),
            lng: Number(selectedLocation.lng),
            name: selectedLocation.formatted_address
          });
          continue;
        }
        var previous = points.length ? [points[points.length - 1].lat, points[points.length - 1].lng] : null;
        var coords = await GR.geocode(names[index], previous);
        points.push({ lat: coords[0], lng: coords[1], name: names[index] });
      }
      if (token !== routeToken) return null;

      // One server endpoint resolves the path, including intermediate stops.
      // The provider URL used to be duplicated in this file and in app.js.
      var data = await GR.api("/api/route", {
        method: "POST",
        body: JSON.stringify({
          origin: [points[0].lat, points[0].lng],
          destination: [points[points.length - 1].lat, points[points.length - 1].lng],
          waypoints: points.slice(1, -1).map(function (point) { return [point.lat, point.lng]; }),
          reason: "trip-create"
        })
      });
      if (token !== routeToken) return null;

      var route = data.route;
      if (!route || !route.geometry || route.geometry.length < 2) {
        throw new Error("No driving route could be calculated between these locations.");
      }
      routeState = {
        distance_km: route.distance_km,
        duration_min: Math.max(1, Math.round(route.duration_min || 1)),
        origin_lat: points[0].lat,
        origin_lng: points[0].lng,
        destination_lat: points[points.length - 1].lat,
        destination_lng: points[points.length - 1].lng,
        provider: route.provider,
        geometry: route.geometry
      };
      distanceValue.value = String(routeState.distance_km);
      durationValue.value = String(routeState.duration_min);
      distanceField.value = formatDistance(routeState.distance_km);
      durationField.value = formatDuration(routeState.duration_min);
      if (summaryDistance) summaryDistance.textContent = formatDistance(routeState.distance_km);
      if (summaryDuration) summaryDuration.textContent = formatDuration(routeState.duration_min);
      routedLocationSelection("origin", points[0]);
      routedLocationSelection("destination", points[points.length - 1]);
      drawRoute(points, routeState.geometry);
      setRouteStatus("Route calculated. Estimate only — no live traffic is used.");
      scheduleResourceRefresh();
      return routeState;
    } catch (error) {
      if (token !== routeToken) return null;
      setRouteStatus(error.message || "The route could not be calculated.", "is-error");
      if (!options.silent && GR.toast) GR.toast(error.message || "Route calculation failed.", "error");
      return null;
    } finally {
      if (token === routeToken) setLoading(calculateButton, false);
    }
  }

  if (mapElement) initMap();

  if (calculateButton) {
    calculateButton.addEventListener("click", function () { calculateRoute(); });
  }

  if (fitButton) {
    fitButton.addEventListener("click", function () {
      if (!map || !routeBounds) {
        if (GR.toast) GR.toast("Calculate the route before fitting the map.", "error");
        return;
      }
      map.fitBounds(routeBounds, { padding: [38, 38] });
    });
  }

  if (fullscreenButton && mapWrap) {
    fullscreenButton.addEventListener("click", function () {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      } else if (mapWrap.requestFullscreen) {
        mapWrap.requestFullscreen().catch(function () {
          if (GR.toast) GR.toast("Fullscreen is not available in this browser.", "error");
        });
      }
    });
    document.addEventListener("fullscreenchange", function () {
      window.setTimeout(function () { if (map) map.invalidateSize(); }, 160);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Location autocomplete                                              */
  /* ------------------------------------------------------------------ */

  var locationConfigs = { origin: null, destination: null };
  var LOCATION_MIN_CHARS = 3;
  var LOCATION_DEBOUNCE_MS = 320;

  function locationConfig(name) {
    var input = name === "origin" ? originField : destinationField;
    var field = input.closest(".create-location-field");
    return {
      name: name,
      input: input,
      field: field,
      dropdown: field.querySelector("[data-location-suggest]"),
      status: field.querySelector("[data-location-status]"),
      clear: field.querySelector("[data-location-clear]"),
      lat: field.querySelector("[data-location-lat]"),
      lng: field.querySelector("[data-location-lng]"),
      placeId: field.querySelector("[data-location-place-id]"),
      items: [],
      active: -1,
      timer: null,
      controller: null,
      requestId: 0
    };
  }

  function setLocationStatus(config, state, message) {
    if (!config || !config.status) return;
    config.status.dataset.state = state;
    config.status.textContent = message;
  }

  function currentLocationSelection(name) {
    var config = locationConfigs[name];
    var selection = locationSelections[name];
    if (!config || !selection) return null;
    if (config.input.value.trim() !== String(selection.formatted_address || "").trim()) return null;
    return selection;
  }

  function writeLocationFields(config, selection) {
    config.lat.value = selection ? String(selection.lat) : "";
    config.lng.value = selection ? String(selection.lng) : "";
    config.placeId.value = selection && selection.place_id ? String(selection.place_id) : "";
  }

  function closeLocationSuggestions(config) {
    if (!config) return;
    config.dropdown.hidden = true;
    config.input.setAttribute("aria-expanded", "false");
    config.input.removeAttribute("aria-activedescendant");
    config.active = -1;
  }

  function openLocationSuggestions(config) {
    if (!config) return;
    config.dropdown.hidden = false;
    config.input.setAttribute("aria-expanded", "true");
  }

  function locationAttribution() {
    var footer = document.createElement("div");
    footer.className = "create-location-attribution";
    footer.append("Search results from ");
    var link = document.createElement("a");
    link.href = "https://photon.komoot.io/";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Photon";
    footer.append(link, " using OpenStreetMap data. Coordinates are recorded only after you choose a result.");
    return footer;
  }

  function locationSuggestionHead() {
    var head = document.createElement("div");
    head.className = "create-location-suggest-head";
    var label = document.createElement("span");
    label.textContent = "Suggested places";
    var provider = document.createElement("span");
    provider.textContent = "Photon · OSM";
    head.append(label, provider);
    return head;
  }

  function renderLocationMessage(config, tone, message, retry) {
    config.items = [];
    config.active = -1;
    config.dropdown.replaceChildren(locationSuggestionHead());
    var row = document.createElement("div");
    row.className = "create-location-state" + (tone === "error" ? " is-error" : "");
    if (tone === "loading") {
      var spinner = document.createElement("span");
      spinner.className = "create-location-spinner";
      spinner.setAttribute("aria-hidden", "true");
      row.appendChild(spinner);
    }
    var copy = document.createElement("span");
    copy.textContent = message;
    row.appendChild(copy);
    if (retry) {
      var retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "create-location-retry";
      retryButton.setAttribute("data-location-retry", "");
      retryButton.textContent = "Try again";
      row.appendChild(retryButton);
    }
    config.dropdown.appendChild(row);
    config.dropdown.appendChild(locationAttribution());
    openLocationSuggestions(config);
  }

  function setLocationActive(config, index) {
    if (!config.items.length) return;
    config.active = (index + config.items.length) % config.items.length;
    var options = config.dropdown.querySelectorAll(".create-location-option");
    Array.prototype.forEach.call(options, function (option, optionIndex) {
      var active = optionIndex === config.active;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    });
    var activeOption = options[config.active];
    if (activeOption) config.input.setAttribute("aria-activedescendant", activeOption.id);
    else config.input.removeAttribute("aria-activedescendant");
    if (activeOption && activeOption.scrollIntoView) activeOption.scrollIntoView({ block: "nearest" });
  }

  function renderLocationSuggestions(config, suggestions) {
    config.items = suggestions;
    config.active = -1;
    config.dropdown.replaceChildren(locationSuggestionHead());
    suggestions.forEach(function (suggestion, index) {
      var option = document.createElement("button");
      option.type = "button";
      option.className = "create-location-option";
      option.id = config.name + "-location-option-" + index;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.setAttribute("data-location-index", String(index));

      var icon = document.createElement("span");
      icon.className = "create-location-option-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>';

      var copy = document.createElement("span");
      copy.className = "create-location-option-copy";
      var primary = document.createElement("strong");
      primary.textContent = suggestion.primary || suggestion.name || suggestion.formatted_address;
      var secondary = document.createElement("span");
      secondary.textContent = suggestion.secondary || suggestion.formatted_address || "";
      copy.append(primary, secondary);

      var kind = document.createElement("span");
      kind.className = "create-location-kind";
      kind.textContent = suggestion.kind || "Place";

      option.append(icon, copy, kind);
      config.dropdown.appendChild(option);
    });
    config.dropdown.appendChild(locationAttribution());
    openLocationSuggestions(config);
  }

  function chooseLocationSuggestion(config, suggestion) {
    if (!config || !suggestion) return;
    locationSelections[config.name] = suggestion;
    config.input.value = suggestion.formatted_address;
    writeLocationFields(config, suggestion);
    config.clear.hidden = false;
    setLocationStatus(config, "verified", "Verified location · latitude and longitude recorded.");
    closeLocationSuggestions(config);
    setSummaryText(
      config.name === "origin" ? summaryOrigin : summaryDestination,
      suggestion.formatted_address,
      config.name === "origin" ? "Incident location not set" : "Response destination not set"
    );
    invalidateRoute("Location verified — calculate the route to refresh the estimate.");
    updateSummary();
    markDirty();
  }

  function scheduleLocationSearch(config, immediate) {
    if (!geocodingEnabled) return;
    window.clearTimeout(config.timer);
    var query = config.input.value.trim();
    if (query.length < LOCATION_MIN_CHARS) {
      config.requestId += 1;
      if (config.controller) config.controller.abort();
      closeLocationSuggestions(config);
      config.items = [];
      setLocationStatus(
        config,
        query ? "unresolved" : "empty",
        query
          ? "Keep typing or enter the full address manually. Coordinates are stored after a route lookup or a verified selection."
          : "Search for a place or enter the address manually."
      );
      return;
    }

    var run = function () { searchLocations(config, query); };
    if (immediate) run();
    else config.timer = window.setTimeout(run, LOCATION_DEBOUNCE_MS);
  }

  async function searchLocations(config, query) {
    config.requestId += 1;
    var requestId = config.requestId;
    if (config.controller) config.controller.abort();
    var controller = new AbortController();
    config.controller = controller;
    setLocationStatus(config, "loading", "Searching OpenStreetMap places…");
    renderLocationMessage(config, "loading", "Searching places…");

    var params = new URLSearchParams({ q: query, limit: "6" });
    var counterpart = currentLocationSelection(config.name === "origin" ? "destination" : "origin");
    var near = counterpart ? [counterpart.lat, counterpart.lng] : null;
    if (!near && map) {
      var mapCenter = map.getCenter();
      if (mapCenter && Number.isFinite(mapCenter.lat) && Number.isFinite(mapCenter.lng)) {
        near = [mapCenter.lat, mapCenter.lng];
      }
    }
    if (near) {
      params.set("near_lat", String(near[0]));
      params.set("near_lng", String(near[1]));
    }

    try {
      var response = await fetch("/api/locations/suggest?" + params.toString(), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal
      });
      var data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      if (requestId !== config.requestId) return;
      if (!response.ok) {
        throw new Error((data && (data.error || data.message)) || "Location search is unavailable right now.");
      }
      var suggestions = data && Array.isArray(data.suggestions) ? data.suggestions : [];
      if (!suggestions.length) {
        renderLocationMessage(
          config,
          "empty",
          (data && data.message) || "No matching places were found. Check the spelling or enter the address manually."
        );
        setLocationStatus(config, "unresolved", "No matching place found. Enter the full address manually or refine the search.");
        return;
      }
      renderLocationSuggestions(config, suggestions);
      setLocationStatus(
        config,
        "unresolved",
        suggestions.length + " place" + (suggestions.length === 1 ? "" : "s") + " found. Choose one to record its coordinates."
      );
    } catch (error) {
      if (error.name === "AbortError" || requestId !== config.requestId) return;
      renderLocationMessage(config, "error", error.message || "Location search failed.", true);
      setLocationStatus(config, "error", error.message || "Location search failed. You can still enter the address manually.");
    } finally {
      if (requestId === config.requestId) config.controller = null;
    }
  }

  function clearLocationSelection(config, keepText) {
    locationSelections[config.name] = null;
    writeLocationFields(config, null);
    if (!keepText) config.input.value = "";
    config.clear.hidden = !config.input.value.trim();
    config.items = [];
    closeLocationSuggestions(config);
    setLocationStatus(
      config,
      config.input.value.trim() ? "unresolved" : "empty",
      config.input.value.trim()
        ? "Address not verified. Select a suggestion or calculate the route to store coordinates."
        : "Search for a place or enter the address manually."
    );
  }

  function restoreLocationSelection(name, selection, text) {
    var config = locationConfigs[name];
    if (!config || !selection || !selection.formatted_address) return false;
    if (String(text || "").trim() !== String(selection.formatted_address).trim()) return false;
    var lat = Number(selection.lat);
    var lng = Number(selection.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
    locationSelections[name] = selection;
    config.input.value = selection.formatted_address;
    writeLocationFields(config, selection);
    config.clear.hidden = false;
    setLocationStatus(config, "verified", "Verified location · latitude and longitude recorded.");
    return true;
  }

  function routedLocationSelection(name, point) {
    var config = locationConfigs[name];
    if (!config || !point) return;
    if (currentLocationSelection(name)) return;
    var selection = {
      formatted_address: config.input.value.trim(),
      primary: config.input.value.trim(),
      secondary: "Verified by address lookup",
      lat: point.lat,
      lng: point.lng,
      place_id: "",
      provider: "nominatim"
    };
    locationSelections[name] = selection;
    writeLocationFields(config, selection);
    setLocationStatus(config, "verified", "Address verified by route lookup · coordinates recorded.");
  }

  function initializeLocationAutocomplete() {
    ["origin", "destination"].forEach(function (name) {
      var config = locationConfig(name);
      locationConfigs[name] = config;
      config.clear.hidden = !config.input.value.trim();
      if (!geocodingEnabled) {
        setLocationStatus(config, "error", "Location search is disabled in Settings. Enter the address manually.");
        return;
      }
      if (config.input.value.trim()) {
        setLocationStatus(config, "unresolved", "Address not verified. Select a suggestion or calculate the route to store coordinates.");
      }

      config.input.addEventListener("input", function () {
        var selection = locationSelections[name];
        if (selection && config.input.value.trim() !== String(selection.formatted_address || "").trim()) {
          locationSelections[name] = null;
          writeLocationFields(config, null);
        }
        config.clear.hidden = !config.input.value.trim();
        setLocationStatus(
          config,
          config.input.value.trim() ? "unresolved" : "empty",
          config.input.value.trim()
            ? "Address not verified. Select a suggestion or calculate the route to store coordinates."
            : "Search for a place or enter the address manually."
        );
        setSummaryText(
          name === "origin" ? summaryOrigin : summaryDestination,
          config.input.value.trim(),
          name === "origin" ? "Incident location not set" : "Response destination not set"
        );
        invalidateRoute("Locations changed — recalculate the route.");
        updateSummary();
        markDirty();
        scheduleLocationSearch(config, false);
      });

      config.input.addEventListener("focus", function () {
        if (!geocodingEnabled || config.input.value.trim().length < LOCATION_MIN_CHARS) return;
        if (currentLocationSelection(name)) return;
        if (config.items.length && config.dropdown.children.length > 1) openLocationSuggestions(config);
        else scheduleLocationSearch(config, true);
      });

      config.input.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          if (!config.dropdown.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closeLocationSuggestions(config);
          }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (config.dropdown.hidden) {
            if (config.input.value.trim().length >= LOCATION_MIN_CHARS) {
              event.preventDefault();
              scheduleLocationSearch(config, true);
            }
            return;
          }
          if (!config.items.length) return;
          event.preventDefault();
          var step = event.key === "ArrowDown" ? 1 : -1;
          setLocationActive(config, config.active < 0 ? (step > 0 ? 0 : config.items.length - 1) : config.active + step);
          return;
        }
        if (event.key === "Enter" && !config.dropdown.hidden && config.items.length) {
          event.preventDefault();
          chooseLocationSuggestion(config, config.items[config.active < 0 ? 0 : config.active]);
          return;
        }
        if (event.key === "Tab") closeLocationSuggestions(config);
      });

      config.clear.addEventListener("click", function () {
        clearLocationSelection(config, false);
        config.input.focus();
        updateSummary();
        invalidateRoute("Locations changed — recalculate the route.");
        markDirty();
      });

      config.dropdown.addEventListener("mousedown", function (event) {
        if (event.target.closest(".create-location-option")) event.preventDefault();
      });
      config.dropdown.addEventListener("mousemove", function (event) {
        var option = event.target.closest(".create-location-option");
        if (option) setLocationActive(config, Number(option.getAttribute("data-location-index")));
      });
      config.dropdown.addEventListener("click", function (event) {
        var option = event.target.closest(".create-location-option");
        if (option) {
          chooseLocationSuggestion(config, config.items[Number(option.getAttribute("data-location-index"))]);
          return;
        }
        if (event.target.closest("[data-location-retry]")) scheduleLocationSearch(config, true);
      });
    });

    document.addEventListener("pointerdown", function (event) {
      ["origin", "destination"].forEach(function (name) {
        var config = locationConfigs[name];
        if (config && !config.field.contains(event.target)) closeLocationSuggestions(config);
      });
    });
    window.addEventListener("resize", function () {
      ["origin", "destination"].forEach(function (name) {
        var config = locationConfigs[name];
        if (config) closeLocationSuggestions(config);
      });
    });
  }

  initializeLocationAutocomplete();

  document.addEventListener("click", function (event) {
    var focusButton = event.target.closest("[data-focus-location]");
    if (!focusButton) return;
    var target = focusButton.getAttribute("data-focus-location") === "origin" ? originField : destinationField;
    target.focus();
    target.select();
  });

  /* ------------------------------------------------------------------ */
  /* Draft                                                              */
  /* ------------------------------------------------------------------ */

  var autosave = $(".create-autosave");
  var autosaveLabel = $("[data-autosave-label]");

  function collectDraft() {
    return {
      name: nameField.value,
      emergency_type: typeField.value,
      priority: priorityField.value,
      status: statusField.value,
      dispatch_at: dispatchField.value,
      origin: originField.value,
      destination: destinationField.value,
      location_origin: locationSelections.origin,
      location_destination: locationSelections.destination,
      instructions: instructionsField.value,
      notes: notesField.value,
      waypoints: waypointNames(),
      vehicle_id: vehicleSelect ? vehicleSelect.value : "",
      crew_ids: selectedCrewIds()
    };
  }

  function saveDraft(manual) {
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ saved_at: Date.now(), values: collectDraft() }));
      if (autosaveLabel) {
        autosaveLabel.textContent = "Draft saved · " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
      }
      if (manual && GR.toast) GR.toast("Draft saved in this browser.");
    } catch (error) {
      if (manual && GR.toast) GR.toast("This browser could not store a local draft.", "error");
    } finally {
      if (autosave) autosave.classList.remove("is-saving");
    }
  }

  function markDirty() {
    dirty = true;
    if (autosave) autosave.classList.add("is-saving");
    if (autosaveLabel) autosaveLabel.textContent = "Saving local draft…";
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(function () { saveDraft(false); }, 800);
  }

  function restoreDraft() {
    if (hasServerErrors) return;
    var raw = null;
    try { raw = window.localStorage.getItem(draftKey); } catch (error) { return; }
    if (!raw) return;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (error) { return; }
    var saved = parsed && parsed.values;
    if (!saved) return;
    if (nameField.value.trim() || originField.value.trim() || destinationField.value.trim()) return;

    nameField.value = saved.name || "";
    if (saved.emergency_type) setType(saved.emergency_type, false);
    if (saved.priority) setPriority(saved.priority);
    if (saved.status) {
      statusField.value = saved.status;
      if (statusExplicitField) statusExplicitField.value = "1";
    }
    if (saved.dispatch_at) dispatchField.value = saved.dispatch_at;
    originField.value = saved.origin || "";
    destinationField.value = saved.destination || "";
    var restoredOrigin = restoreLocationSelection("origin", saved.location_origin, saved.origin);
    var restoredDestination = restoreLocationSelection("destination", saved.location_destination, saved.destination);
    if (!restoredOrigin && originField.value.trim()) {
      setLocationStatus(locationConfigs.origin, "unresolved", "Address not verified. Select a suggestion or calculate the route to store coordinates.");
    }
    if (!restoredDestination && destinationField.value.trim()) {
      setLocationStatus(locationConfigs.destination, "unresolved", "Address not verified. Select a suggestion or calculate the route to store coordinates.");
    }
    instructionsField.value = saved.instructions || "";
    notesField.value = saved.notes || "";
    if (vehicleSelect && saved.vehicle_id) vehicleSelect.value = String(saved.vehicle_id);
    if (crewList && Array.isArray(saved.crew_ids)) {
      var savedCrew = saved.crew_ids.map(String);
      $$('input[name="crew_ids"]', crewList).forEach(function (input) {
        input.checked = !input.disabled && savedCrew.indexOf(input.value) >= 0;
      });
    }
    waypointsContainer.replaceChildren();
    (saved.waypoints || []).slice(0, 4).forEach(function (name) {
      waypointsContainer.appendChild(createWaypointCard(name));
    });
    syncWaypoints(false);
    updateSummary();
    if (autosaveLabel && parsed.saved_at) {
      autosaveLabel.textContent = "Local draft restored · " + new Date(parsed.saved_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    if (GR.toast) GR.toast("A saved local draft was restored.");
    if (saved.origin && saved.destination) {
      window.setTimeout(function () { calculateRoute({ silent: true }); }, 350);
    }
  }

  $$("[data-save-draft]").forEach(function (button) {
    button.addEventListener("click", function () { saveDraft(true); });
  });

  ["input", "change"].forEach(function (eventName) {
    form.addEventListener(eventName, function (event) {
      if (event.target.closest("[data-waypoint]")) return;
      updateSummary();
      markDirty();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Reuse last response                                                */
  /* ------------------------------------------------------------------ */

  var lastDataNode = document.getElementById("last-response-data");
  var lastResponse = null;
  if (lastDataNode) {
    try { lastResponse = JSON.parse(lastDataNode.textContent); } catch (error) { lastResponse = null; }
  }

  var reuseButton = $("[data-reuse-last]");
  if (reuseButton && lastResponse) {
    reuseButton.addEventListener("click", function () {
      originField.value = lastResponse.origin || "";
      destinationField.value = lastResponse.destination || "";
      var reusedOrigin = null;
      var reusedDestination = null;
      if (Array.isArray(lastResponse.origin_coords) && lastResponse.origin_coords.length === 2) {
        reusedOrigin = {
          formatted_address: lastResponse.origin || "",
          primary: lastResponse.origin || "",
          secondary: "Stored response location",
          lat: lastResponse.origin_coords[0],
          lng: lastResponse.origin_coords[1],
          place_id: lastResponse.origin_place_id || "",
          provider: "stored"
        };
      }
      if (Array.isArray(lastResponse.destination_coords) && lastResponse.destination_coords.length === 2) {
        reusedDestination = {
          formatted_address: lastResponse.destination || "",
          primary: lastResponse.destination || "",
          secondary: "Stored response location",
          lat: lastResponse.destination_coords[0],
          lng: lastResponse.destination_coords[1],
          place_id: lastResponse.destination_place_id || "",
          provider: "stored"
        };
      }
      if (!restoreLocationSelection("origin", reusedOrigin, lastResponse.origin)) {
        clearLocationSelection(locationConfigs.origin, true);
      }
      if (!restoreLocationSelection("destination", reusedDestination, lastResponse.destination)) {
        clearLocationSelection(locationConfigs.destination, true);
      }
      if (lastResponse.name) nameField.value = lastResponse.name;
      if (lastResponse.instructions) instructionsField.value = lastResponse.instructions;
      if (lastResponse.notes) notesField.value = lastResponse.notes;
      if (lastResponse.emergency_type) setType(lastResponse.emergency_type, false);
      if (lastResponse.priority) setPriority(lastResponse.priority);
      waypointsContainer.replaceChildren();
      (lastResponse.waypoints || []).slice(0, 4).forEach(function (name) {
        waypointsContainer.appendChild(createWaypointCard(name));
      });
      syncWaypoints(false);
      invalidateRoute();
      updateSummary();
      markDirty();
      if (GR.toast) GR.toast("Locations copied from " + lastResponse.reference + ".");
      window.setTimeout(function () { calculateRoute({ silent: true }); }, 250);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Validation and submit                                              */
  /* ------------------------------------------------------------------ */

  function showClientError(message) {
    if (!clientError) {
      if (GR.toast) GR.toast(message, "error");
      return;
    }
    if (clientErrorMessage) clientErrorMessage.textContent = message;
    clientError.hidden = false;
    clientError.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function localValidation() {
    var missing = [];
    if (!nameField.value.trim()) missing.push(nameField);
    if (!typeField.value) missing.push(trigger);
    if (!originField.value.trim()) missing.push(originField);
    if (!destinationField.value.trim()) missing.push(destinationField);
    if (!dispatchField.value) missing.push(dispatchField);
    if (missing.length) {
      showClientError("Complete the required response details before creating the assignment.");
      missing[0].focus();
      return false;
    }
    if (originField.value.trim().toLowerCase() === destinationField.value.trim().toLowerCase()) {
      showClientError("The incident location and response destination must be different.");
      destinationField.focus();
      return false;
    }
    var emptyStop = $$("[data-waypoint] input", waypointsContainer).filter(function (input) {
      return !input.value.trim();
    })[0];
    if (emptyStop) {
      showClientError("Name or remove the empty intermediate stop before creating the response.");
      emptyStop.focus();
      return false;
    }
    if (!form.reportValidity()) return false;
    if (clientError) clientError.hidden = true;
    return true;
  }

  function setSubmitting(loading) {
    submitting = loading;
    $$("[data-submit-response]").forEach(function (button) {
      if (loading) {
        if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span><span>Creating response…</span>';
      } else {
        button.disabled = false;
        if (button.dataset.originalHtml) {
          button.innerHTML = button.dataset.originalHtml;
          delete button.dataset.originalHtml;
        }
      }
    });
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (submitting) return;
    if (!localValidation()) return;

    setSubmitting(true);
    if (clientError) clientError.hidden = true;
    try {
      if (!routeState && geocodingEnabled) {
        await calculateRoute({ silent: true });
      }
      var fd = new FormData(form);
      var payload = {};
      fd.forEach(function (value, key) { payload[key] = value; });
      payload.waypoints = waypointNames();
      payload.name = nameField.value.trim();
      payload.origin = originField.value.trim();
      payload.destination = destinationField.value.trim();
      payload.dispatch_at = dispatchField.value;
      payload.vehicle_id = vehicleSelect ? vehicleSelect.value : "";
      payload.crew_ids = selectedCrewIds();
      var originSelection = currentLocationSelection("origin");
      var destinationSelection = currentLocationSelection("destination");
      if (routeState) {
        payload.origin_lat = routeState.origin_lat;
        payload.origin_lng = routeState.origin_lng;
        payload.destination_lat = routeState.destination_lat;
        payload.destination_lng = routeState.destination_lng;
        payload.distance_km = routeState.distance_km;
        payload.duration_min = routeState.duration_min;
      } else if (originSelection && destinationSelection) {
        payload.origin_lat = originSelection.lat;
        payload.origin_lng = originSelection.lng;
        payload.destination_lat = destinationSelection.lat;
        payload.destination_lng = destinationSelection.lng;
        delete payload.distance_km;
        delete payload.duration_min;
      } else {
        delete payload.origin_lat;
        delete payload.origin_lng;
        delete payload.destination_lat;
        delete payload.destination_lng;
        delete payload.origin_place_id;
        delete payload.destination_place_id;
        delete payload.distance_km;
        delete payload.duration_min;
      }

      var response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      var data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      if (!response.ok) {
        if (data && data.errors) {
          var firstKey = Object.keys(data.errors)[0];
          var field = form.elements[firstKey];
          if (field && field.focus) field.focus();
        }
        throw new Error((data && data.error) || "The response could not be saved (" + response.status + ").");
      }
      try { window.localStorage.removeItem(draftKey); } catch (error) { /* local draft is optional */ }
      dirty = false;
      if (GR.toast) GR.toast("Response recorded.");
      window.location.assign(data.trip.url + "?created=1");
    } catch (error) {
      showClientError(error.message || "The response could not be saved.");
      setSubmitting(false);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Cancel, initial state                                              */
  /* ------------------------------------------------------------------ */

  var cancelLink = $("[data-cancel-response]");
  if (cancelLink && GR.confirm) {
    cancelLink.addEventListener("click", async function (event) {
      if (!dirty) return;
      event.preventDefault();
      var proceed = await GR.confirm({
        title: "Leave this response?",
        message: "The local draft stays in this browser. Any unsaved route calculation is discarded.",
        confirmLabel: "Leave without saving",
        danger: true
      });
      if (proceed) window.location.href = cancelLink.getAttribute("href");
    });
  }

  if (dispatchField) {
    dispatchField.addEventListener("change", function () {
      updateSummary();
      scheduleResourceRefresh();
    });
  }
  if (statusField) {
    statusField.addEventListener("change", function () {
      if (statusExplicitField) statusExplicitField.value = "1";
      updateSummary();
    });
  }

  updateSummary();
  syncWaypoints(false);
  restoreDraft();
  updateSummary();
  syncVehicleDetail();
  scheduleResourceRefresh();
})();
