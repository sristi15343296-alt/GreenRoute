/* Settings: dirty-state tracking and section navigation. */
(function () {
  "use strict";

  var form = document.querySelector("[data-dirty-form]");
  var note = document.querySelector("[data-dirty-note]");
  var dirty = false;

  function serialise() {
    if (!form) return "";
    var data = new FormData(form);
    return Array.from(data.entries())
      .map(function (entry) { return entry[0] + "=" + entry[1]; })
      .sort()
      .join("&");
  }

  if (form) {
    var initial = serialise();

    function check() {
      var changed = serialise() !== initial;
      dirty = changed;
      if (note) note.hidden = !changed;
    }

    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("submit", function () {
      dirty = false;
      if (note) note.hidden = true;
    });

    window.addEventListener("beforeunload", function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  var links = Array.prototype.slice.call(document.querySelectorAll(".settings-nav a[href^='#']"));
  var sections = links
    .map(function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = document.getElementById(id);
      return section ? { link: link, section: section } : null;
    })
    .filter(Boolean);

  var scroller = document.querySelector(".page-body");

  function setActive(link) {
    links.forEach(function (item) { item.classList.toggle("is-active", item === link); });
  }

  links.forEach(function (link) {
    link.addEventListener("click", function (event) {
      var id = link.getAttribute("href").slice(1);
      var section = document.getElementById(id);
      if (!section) return;
      event.preventDefault();
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      setActive(link);
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", "#" + id);
      }
    });
  });

  if (scroller && sections.length) {
    scroller.addEventListener("scroll", function () {
      var top = scroller.scrollTop + 80;
      var current = sections[0];
      sections.forEach(function (item) {
        if (item.section.offsetTop <= top) current = item;
      });
      setActive(current.link);
    }, { passive: true });
  }
})();
