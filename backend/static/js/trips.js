/* Trips register: selection, bulk actions and row state. */
(function () {
  "use strict";

  var bar = document.getElementById("bulk-bar");
  if (!bar) return;

  var checks = Array.prototype.slice.call(document.querySelectorAll("[data-row-check]"));
  var checkAll = document.getElementById("check-all");
  var countNode = document.getElementById("bulk-count");
  var clear = document.getElementById("bulk-clear");
  var actionButtons = Array.prototype.slice.call(document.querySelectorAll("[data-bulk-action]"));

  function selectedIds() {
    return checks.filter(function (check) { return check.checked; }).map(function (check) {
      return Number(check.value);
    });
  }

  function sync() {
    var ids = selectedIds();
    bar.hidden = ids.length === 0;
    if (countNode) countNode.textContent = String(ids.length);
    checks.forEach(function (check) {
      var row = check.closest("tr");
      if (row) row.classList.toggle("is-selected", check.checked);
    });
    if (checkAll) {
      checkAll.checked = checks.length > 0 && ids.length === checks.length;
      checkAll.indeterminate = ids.length > 0 && ids.length < checks.length;
    }
  }

  checks.forEach(function (check) { check.addEventListener("change", sync); });

  if (checkAll) {
    checkAll.addEventListener("change", function () {
      checks.forEach(function (check) { check.checked = checkAll.checked; });
      sync();
    });
  }

  if (clear) {
    clear.addEventListener("click", function () {
      checks.forEach(function (check) { check.checked = false; });
      sync();
    });
  }

  actionButtons.forEach(function (button) {
    button.addEventListener("click", async function () {
      var action = button.getAttribute("data-bulk-action");
      var ids = selectedIds();
      if (!ids.length) return;

      if (action === "cancel") {
        var proceed = await window.GR.confirm({
          title: "Cancel selected trips?",
          message: ids.length + " trip" + (ids.length === 1 ? "" : "s") + " will be closed as cancelled. This cannot be undone.",
          confirmLabel: "Cancel trips",
          danger: true
        });
        if (!proceed) return;
      }

      button.disabled = true;
      try {
        var result = await window.GR.api("/api/trips/bulk", {
          method: "POST",
          body: JSON.stringify({ action: action, ids: ids })
        });
        var message = result.updated + " trip" + (result.updated === 1 ? "" : "s") + " updated";
        if (result.skipped && result.skipped.length) {
          message += " · " + result.skipped.length + " skipped";
        }
        window.GR.toast(message);
        window.setTimeout(function () { window.location.reload(); }, 420);
      } catch (error) {
        window.GR.toast(error.message, "error");
        button.disabled = false;
      }
    });
  });

  sync();
})();
