/* Analytics: Chart.js rendering from recorded trip aggregates. */
(function () {
  "use strict";

  var dataNode = document.getElementById("analytics-data");
  var canvas = document.getElementById("analytics-chart");
  if (!dataNode || !canvas) return;

  var data;
  try {
    data = JSON.parse(dataNode.textContent);
  } catch (error) {
    return;
  }

  if (typeof Chart === "undefined") {
    var frame = canvas.parentElement;
    frame.innerHTML = '<div class="map-fallback">The chart library could not be loaded. Daily aggregates remain available in the table below.</div>';
    return;
  }

  var unit = canvas.getAttribute("data-unit") || "km";
  var factor = unit === "mi" ? 0.621371 : 1;
  var labels = data.series.map(function (day) { return day.label; });
  var trips = data.series.map(function (day) { return day.trips; });
  var distances = data.series.map(function (day) { return Math.round(day.distance * factor * 10) / 10; });

  Chart.defaults.color = "#8c9889";
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 9;

  var chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Trips",
          data: trips,
          backgroundColor: "rgba(104, 132, 101, 0.62)",
          hoverBackgroundColor: "rgba(133, 163, 127, 0.82)",
          borderRadius: 2,
          barPercentage: 0.72,
          categoryPercentage: 0.8,
          yAxisID: "yTrips",
          order: 2
        },
        {
          label: "Distance (" + unit + ")",
          data: distances,
          type: "line",
          borderColor: "#c9f94c",
          backgroundColor: "#c9f94c",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: "#c9f94c",
          pointHoverBorderColor: "#080a08",
          pointHoverBorderWidth: 2,
          tension: 0.3,
          fill: false,
          yAxisID: "yDistance",
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(18, 23, 17, 0.96)",
          borderColor: "rgba(237, 244, 232, 0.14)",
          borderWidth: 1,
          titleColor: "#f0f3ec",
          bodyColor: "#b2bcae",
          titleFont: { size: 10, weight: "600" },
          bodyFont: { size: 9 },
          padding: 11,
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 6,
          boxHeight: 6,
          callbacks: {
            label: function (context) {
              if (context.dataset.yAxisID === "yDistance") {
                return "Distance: " + context.parsed.y + " " + unit;
              }
              return "Trips: " + context.parsed.y;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: "#232b21" },
          ticks: {
            color: "#687467",
            font: { family: "'JetBrains Mono', monospace", size: 8 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12
          }
        },
        yTrips: {
          position: "left",
          beginAtZero: true,
          grid: { color: "rgba(237, 244, 232, 0.055)", drawTicks: false },
          border: { display: false },
          ticks: {
            color: "#687467",
            precision: 0,
            font: { family: "'JetBrains Mono', monospace", size: 8 },
            padding: 6
          }
        },
        yDistance: {
          position: "right",
          beginAtZero: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: "#8c9889",
            font: { family: "'JetBrains Mono', monospace", size: 8 },
            padding: 6
          }
        }
      }
    }
  });

  var modes = Array.prototype.slice.call(document.querySelectorAll("[data-chart-mode]"));

  function setMode(mode) {
    modes.forEach(function (button) {
      var active = button.getAttribute("data-chart-mode") === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    var showTrips = mode !== "distance";
    var showDistance = mode !== "trips";

    chart.data.datasets[0].hidden = !showTrips;
    chart.data.datasets[1].hidden = !showDistance;
    chart.options.scales.yTrips.display = showTrips;
    chart.options.scales.yDistance.display = showDistance;
    chart.update();
  }

  modes.forEach(function (button) {
    button.addEventListener("click", function () {
      setMode(button.getAttribute("data-chart-mode"));
    });
  });

  setMode("combined");
})();
