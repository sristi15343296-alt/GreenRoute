/* GreenRoute shared UI behaviour: toasts, menus, modals, trip actions, API helpers. */
(function () {
  "use strict";

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var GR = (window.GR = window.GR || {});

  /* ------------------------------------------------------------------ */
  /* Utilities                                                          */
  /* ------------------------------------------------------------------ */

  GR.escapeHtml = function (value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  };

  function toast(message, tone) {
    var stack = $("#toast-stack");
    if (!stack) return;
    var node = document.createElement("div");
    node.className = "toast" + (tone ? " toast--" + tone : "");
    node.textContent = message;
    stack.appendChild(node);
    window.setTimeout(function () {
      node.classList.add("is-out");
      window.setTimeout(function () { node.remove(); }, 220);
    }, 4200);
  }
  GR.toast = toast;

  function setLoading(button, loading) {
    if (!button) return;
    if (loading) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.classList.add("is-loading");
      button.innerHTML = '<span class="spinner"></span><span>' + (button.dataset.submitLabel || "Working…") + "</span>";
    } else {
      button.disabled = false;
      button.classList.remove("is-loading");
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }
  GR.setLoading = setLoading;

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  async function api(url, options) {
    options = options || {};
    var headers = Object.assign({ Accept: "application/json" }, options.headers || {});
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    // Every state-changing request carries the session's CSRF token; the server
    // rejects the request outright when it is missing or stale.
    if (!headers["X-CSRF-Token"]) {
      var token = csrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }
    var response = await fetch(url, Object.assign({}, options, { headers: headers }));
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }

    if (response.status === 401 && data && data.code === "authentication_required") {
      // The session ended while the page was open. Send the operator back to the
      // sign-in page and bring them back to the same screen afterwards.
      window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
      throw new Error("Your session ended. Sign in again.");
    }
    if (response.status === 400 && data && data.code === "csrf_failed") {
      throw new Error("This page expired. Reload it and try again.");
    }
    if (!response.ok) {
      var message = (data && data.error) || "The request could not be completed (" + response.status + ").";
      if (data && data.code === "reason_required") message = "A reason is required.";
      throw new Error(message);
    }
    return data;
  }
  GR.api = api;

  /* ------------------------------------------------------------------ */
  /* Material reveal                                                    */
  /* ------------------------------------------------------------------ */

  function trackReveal(el) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var raf = 0;
    el.addEventListener("pointermove", function (event) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        var rect = el.getBoundingClientRect();
        el.style.setProperty("--mx", (event.clientX - rect.left) + "px");
        el.style.setProperty("--my", (event.clientY - rect.top) + "px");
        raf = 0;
      });
    }, { passive: true });
  }
  GR.trackReveal = trackReveal;

  /* ------------------------------------------------------------------ */
  /* Menus                                                              */
  /* ------------------------------------------------------------------ */

  var openMenu = null;

  function closeMenus() {
    if (!openMenu) return;
    openMenu.classList.remove("is-open");
    if (openMenu.__trigger) openMenu.__trigger.setAttribute("aria-expanded", "false");
    openMenu.style.left = "";
    openMenu.style.top = "";
    openMenu.__trigger = null;
    openMenu = null;
  }

  function openFloatingMenu(menu, trigger) {
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.classList.add("is-open");
    var rect = trigger.getBoundingClientRect();
    var width = menu.offsetWidth;
    var height = menu.offsetHeight;
    var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    var top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest("[data-menu-toggle]");
    if (trigger) {
      event.preventDefault();
      var menu = document.getElementById(trigger.getAttribute("data-menu-toggle"));
      if (!menu) return;
      var isOpen = menu.classList.contains("is-open");
      closeMenus();
      if (isOpen) return;
      menu.__trigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      if (menu.classList.contains("menu--float")) openFloatingMenu(menu, trigger);
      menu.classList.add("is-open");
      openMenu = menu;
      return;
    }
    if (event.target.closest(".menu-item")) {
      closeMenus();
      return;
    }
    if (!event.target.closest(".menu")) closeMenus();
  });

  document.addEventListener("scroll", function () { closeMenus(); }, true);
  window.addEventListener("resize", function () { closeMenus(); });

  /* ------------------------------------------------------------------ */
  /* Modals                                                             */
  /* ------------------------------------------------------------------ */

  var activeModal = null;
  var lastFocused = null;

  function openModal(target) {
    var modal = typeof target === "string" ? document.querySelector(target) : target;
    if (!modal) return;
    closeMenus();
    lastFocused = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    activeModal = modal;
    var focusable = modal.querySelector("input:not([type=hidden]), select, textarea, button:not([data-modal-close])");
    window.setTimeout(function () { if (focusable) focusable.focus(); }, 60);
  }
  GR.openModal = openModal;

  function closeModal() {
    if (!activeModal) return;
    activeModal.classList.remove("is-open");
    activeModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    activeModal = null;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }
  GR.closeModal = closeModal;

  document.addEventListener("click", function (event) {
    var opener = event.target.closest("[data-modal-open]");
    if (opener) {
      event.preventDefault();
      openModal(opener.getAttribute("data-modal-open"));
      return;
    }
    if (event.target.closest("[data-modal-close]")) {
      event.preventDefault();
      closeModal();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeMenus();
      closeModal();
    }
    if (event.key === "Tab" && activeModal) {
      var focusable = $$("a[href], button:not([disabled]), input:not([type=hidden]), select, textarea", activeModal).filter(function (node) {
        return node.offsetParent !== null;
      });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Confirmation dialog                                                */
  /* ------------------------------------------------------------------ */

  GR.confirm = function (options) {
    options = options || {};
    return new Promise(function (resolve) {
      var modal = document.createElement("div");
      modal.className = "modal is-open";

      var backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";

      var box = document.createElement("div");
      box.className = "modal-box modal-box--confirm";
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");

      var head = document.createElement("div");
      head.className = "confirm-head";
      var icon = document.createElement("span");
      icon.className = "confirm-icon";
      icon.textContent = "!";
      var copy = document.createElement("div");
      var title = document.createElement("h2");
      title.textContent = options.title || "Confirm action";
      var message = document.createElement("p");
      message.textContent = options.message || "Are you sure you want to continue?";
      copy.appendChild(title);
      copy.appendChild(message);
      head.appendChild(icon);
      head.appendChild(copy);

      var actions = document.createElement("div");
      actions.className = "confirm-actions";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-secondary";
      cancel.textContent = options.cancelLabel || "Cancel";
      var confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "btn " + (options.danger ? "btn-danger" : "btn-primary");
      confirm.textContent = options.confirmLabel || "Confirm";

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      box.appendChild(head);
      box.appendChild(actions);
      modal.appendChild(backdrop);
      modal.appendChild(box);

      function finish(value) {
        modal.remove();
        document.body.classList.remove("modal-open");
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function onKey(event) {
        if (event.key === "Escape") finish(false);
      }

      cancel.addEventListener("click", function () { finish(false); });
      confirm.addEventListener("click", function () { finish(true); });
      backdrop.addEventListener("click", function () { finish(false); });
      document.addEventListener("keydown", onKey);

      document.body.classList.add("modal-open");
      document.body.appendChild(modal);
      window.setTimeout(function () { confirm.focus(); }, 40);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Copy to clipboard                                                  */
  /* ------------------------------------------------------------------ */

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest("[data-copy]");
    if (!trigger) return;
    event.preventDefault();
    var value = trigger.getAttribute("data-copy");
    function fallback() {
      var field = document.createElement("textarea");
      field.value = value;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      try { document.execCommand("copy"); toast("Copied to clipboard"); } catch (error) { toast("Copy failed", "error"); }
      field.remove();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(function () { toast("Copied to clipboard"); }, fallback);
    } else {
      fallback();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Trip lifecycle actions                                             */
  /* ------------------------------------------------------------------ */

  var ACTION_COPY = {
    accept: { label: "Response accepted", confirm: null },
    depart: { label: "Response en route", confirm: null },
    arrive: { label: "Crew marked on scene", confirm: null },
    start: { label: "Trip started", confirm: null },
    complete: { label: "Trip marked as completed", confirm: null },
    cancel: {
      label: "Trip cancelled",
      confirm: {
        title: "Cancel this trip?",
        message: "The trip will be closed as cancelled. This cannot be undone.",
        confirmLabel: "Cancel trip",
        danger: true
      }
    }
  };

  document.addEventListener("click", async function (event) {
    var button = event.target.closest("[data-trip-action]");
    if (!button) return;
    event.preventDefault();
    var action = button.getAttribute("data-trip-action");
    var tripId = button.getAttribute("data-trip-id");
    if (!action || !tripId) return;

    var config = ACTION_COPY[action];
    if (!config) return;
    if (config.confirm && !(await GR.confirm(config.confirm))) return;

    // Cancelling must be explainable afterwards, so the audit trail gets a
    // reason rather than "cancelled by anonymous operator".
    var payload = { action: action };
    if (action === "cancel") {
      var reason = window.prompt("Why is this response being cancelled?");
      if (reason === null) return;
      reason = (reason || "").trim();
      if (reason.length < 3) {
        toast("Give a short reason for cancelling.", "error");
        return;
      }
      payload.reason = reason;
    }

    var original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>';
    try {
      await api("/api/trips/" + tripId, { method: "PATCH", body: JSON.stringify(payload) });
      toast(config.label);
      window.setTimeout(function () { window.location.reload(); }, 380);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = original;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Forms, refresh and row navigation                                  */
  /* ------------------------------------------------------------------ */

  $$("[data-refresh]").forEach(function (button) {
    button.addEventListener("click", function () {
      button.disabled = true;
      window.location.reload();
    });
  });

  document.addEventListener("click", function (event) {
    var row = event.target.closest("[data-row-href]");
    if (!row) return;
    if (event.target.closest("a, button, input, select, textarea, label")) return;
    window.location.href = row.getAttribute("data-row-href");
  });

  $$("[data-auto-submit]").forEach(function (control) {
    control.addEventListener("change", function () {
      if (control.form) control.form.requestSubmit();
    });
  });

  var searchInput = $("[data-search-input]");
  if (searchInput) {
    var searchTimer = null;
    searchInput.addEventListener("input", function () {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        if (searchInput.form) searchInput.form.requestSubmit();
      }, 480);
    });
  }

  document.addEventListener("keydown", function (event) {
    var tag = document.activeElement ? document.activeElement.tagName : "";
    if (event.key === "/" && !/input|textarea|select/i.test(tag) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      var field = $("[data-search-input]") || $("#map-search");
      if (field) {
        event.preventDefault();
        field.focus();
        if (field.select) field.select();
      }
    }
  });

  /* Confirmation on plain forms (settings reset, etc.) */
  document.addEventListener("submit", async function (event) {
    var form = event.target.closest("form[data-confirm]");
    if (!form) return;
    event.preventDefault();
    var proceed = await GR.confirm({
      title: "Please confirm",
      message: form.getAttribute("data-confirm"),
      confirmLabel: "Continue",
      danger: true
    });
    if (proceed) HTMLFormElement.prototype.submit.call(form);
  });

  /* ------------------------------------------------------------------ */
  /* Geocoding and route estimation                                     */
  /* ------------------------------------------------------------------ */

  async function fetchJson(url, timeout) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, timeout || 9000);
    try {
      var response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("The lookup service is unavailable.");
      return await response.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function geocode(place, near) {
    var address = String(place || "").trim();
    if (!address) {
      var empty = new Error("This trip does not have an address to look up.");
      empty.code = "missing_address";
      throw empty;
    }

    var url = new URL("/api/geocode", window.location.origin);
    url.searchParams.set("address", address);
    if (near && near.length === 2) {
      url.searchParams.set("near_lat", near[0]);
      url.searchParams.set("near_lng", near[1]);
    }

    var response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    });
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok || !data || data.status !== "resolved") {
      var message = (data && (data.message || data.error)) ||
        "The address could not be resolved (" + response.status + ").";
      var failure = new Error(message);
      failure.code = (data && data.status) || "unavailable";
      failure.status = response.status;
      throw failure;
    }
    return [Number(data.lat), Number(data.lng)];
  }

  async function resolveRoute(origin, destination) {
    // Resolve sequentially so the geocoder's rate limit is respected. The
    // destination uses the origin as nearby context.
    var from = await geocode(origin);
    var to = await geocode(destination, from);
    // Routing is a server concern now. It used to be built here and again in
    // trip_create.js, so the two screens could disagree about the same road.
    var data = await api("/api/route", {
      method: "POST",
      body: JSON.stringify({ origin: from, destination: to, reason: "trip-create" })
    });
    var route = data.route;
    if (!route || !route.geometry || route.geometry.length < 2) {
      throw new Error("No driving route could be calculated between these addresses.");
    }
    return {
      origin_lat: from[0],
      origin_lng: from[1],
      destination_lat: to[0],
      destination_lng: to[1],
      distance_km: route.distance_km,
      duration_min: Math.max(1, Math.round(route.duration_min || 1)),
      provider: route.provider,
      geometry: route.geometry
    };
  }

  GR.geocode = geocode;
  GR.resolveRoute = resolveRoute;

  /* ------------------------------------------------------------------ */
  /* Sidebar drawer                                                     */
  /* ------------------------------------------------------------------ */

  $$(".acrylic").forEach(trackReveal);

  var sidebar = $("#app-sidebar");
  var sidebarOpen = $("[data-sidebar-open]");

  function setSidebar(open) {
    if (!sidebar) return;
    sidebar.classList.toggle("is-open", open);
    document.body.classList.toggle("nav-open", open);
    if (sidebarOpen) sidebarOpen.setAttribute("aria-expanded", String(open));
  }

  if (sidebarOpen) {
    sidebarOpen.addEventListener("click", function () { setSidebar(true); });
  }
  $$("[data-sidebar-close]").forEach(function (button) {
    button.addEventListener("click", function () { setSidebar(false); });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setSidebar(false);
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 1024) setSidebar(false);
  });

  /* ------------------------------------------------------------------ */
  /* Flash messages                                                     */
  /* ------------------------------------------------------------------ */

  if (Array.isArray(window.__GR_FLASH)) {
    window.__GR_FLASH.forEach(function (entry) {
      toast(entry[1], entry[0] === "error" ? "error" : "success");
    });
  }
})();
