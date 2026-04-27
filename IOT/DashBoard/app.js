/* ============================================================
   CrisisBridge — Dashboard Logic  (app.js)
   Fetches data from ThingSpeak and drives all UI components.
   ============================================================ */

// ── ThingSpeak Configuration ──
const CHANNEL_ID = "3359560";
const READ_API   = "H8KCPYPXD0EZZRVJ";
const RESULTS    = 30;                       // last N data-points
const POLL_MS    = 6000;                     // refresh every 6 s

// ── State names matching ESP32 enum ──
const STATE_NAMES = ["SAFE", "WARNING", "CRITICAL", "ALERT_SENT", "ACKNOWLEDGED", "ESCALATED"];
const STATE_CLASS = ["safe", "warn", "crit", "crit", "ack", "crit"];

// ── Chart instances ──
let chartTemp = null;
let chartHum  = null;
let chartRisk = null;

// ── Tracking ──
let alertsToday  = 0;
let lastAlertStr = "—";
let lastAckStr   = "—";
let prevCritical = false;
const startTime  = Date.now();

/* ================================================================
   BOOTSTRAP
   ================================================================ */
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  fetchAndRender();
  setInterval(fetchAndRender, POLL_MS);
  setInterval(updateUptime, 60000);
});

/* ================================================================
   DATA FETCHING
   ================================================================ */
async function fetchAndRender() {
  try {
    const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${READ_API}&results=${RESULTS}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();

    setOnline(true);
    processFeeds(data.feeds || []);
  } catch (err) {
    console.error("Fetch error:", err);
    setOnline(false);
  }
}

/* ================================================================
   PROCESS FEEDS
   ================================================================ */
function processFeeds(feeds) {
  if (!feeds.length) return;

  const latest = feeds[feeds.length - 1];

  const temp  = parseFloat(latest.field1) || 0;
  const hum   = parseFloat(latest.field2) || 0;
  const risk  = parseFloat(latest.field3) || 0;
  const prox  = parseInt(latest.field4)   || 0;
  const state = parseInt(latest.field5)   || 0;
  const ack   = parseInt(latest.field6)   || 0;

  // ── Live cards ──
  updateCard("temp", temp, temp, 50);       // max 50 °C for bar
  updateCard("hum",  hum,  hum,  100);
  updateCard("risk", risk, risk, 100);
  updateCard("prox", prox, prox, 8);

  // ── Side panel state ──
  updateStateIndicator(state);

  // ── Risk gauge ──
  drawGauge(risk);
  document.getElementById("gauge-value").textContent = Math.round(risk);

  // ── Gauge value gradient color ──
  const gv = document.getElementById("gauge-value");
  if (risk < 30) {
    gv.style.background = "linear-gradient(135deg, #22c55e, #06b6d4)";
  } else if (risk < 60) {
    gv.style.background = "linear-gradient(135deg, #eab308, #f97316)";
  } else {
    gv.style.background = "linear-gradient(135deg, #ef4444, #dc2626)";
  }
  gv.style.webkitBackgroundClip = "text";
  gv.style.webkitTextFillColor = "transparent";
  gv.style.backgroundClip = "text";

  // ── Alert detection ──
  if (state >= 2 && !prevCritical) {
    alertsToday++;
    lastAlertStr = timeAgo(new Date(latest.created_at));
    document.getElementById("stat-alerts").textContent = alertsToday;
    document.getElementById("stat-last-alert").textContent = lastAlertStr;
    showAlert(risk);
  }
  prevCritical = (state >= 2);

  if (ack === 1) {
    lastAckStr = timeAgo(new Date(latest.created_at));
    document.getElementById("stat-last-ack").textContent = lastAckStr;
  }

  // ── Charts ──
  const labels = feeds.map(f => {
    const d = new Date(f.created_at);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  updateChart(chartTemp, labels, feeds.map(f => parseFloat(f.field1) || null));
  updateChart(chartHum,  labels, feeds.map(f => parseFloat(f.field2) || null));
  updateChart(chartRisk, labels, feeds.map(f => parseFloat(f.field3) || null));

  // ── Event log ──
  buildEventLog(feeds);

  // ── Last update ──
  document.getElementById("last-update").textContent =
    "Updated " + new Date().toLocaleTimeString();
}

/* ================================================================
   UI HELPERS
   ================================================================ */

// -- Cards --
function updateCard(id, displayVal, rawVal, maxVal) {
  document.getElementById(`val-${id}`).textContent =
    typeof displayVal === "number" ? displayVal.toFixed(1) : displayVal;
  const pct = Math.min((rawVal / maxVal) * 100, 100);
  document.getElementById(`bar-${id}`).style.width = pct + "%";
}

// -- State indicator --
function updateStateIndicator(stateNum) {
  const label = STATE_NAMES[stateNum] || "UNKNOWN";
  const cls   = STATE_CLASS[stateNum] || "safe";

  document.getElementById("state-label").textContent = label;
  const glow = document.getElementById("state-glow");

  const colors = {
    safe: "var(--accent-green)",
    warn: "var(--accent-yellow)",
    crit: "var(--accent-red)",
    ack:  "var(--accent-blue)"
  };
  glow.style.background = colors[cls] || colors.safe;
}

// -- Connection badge --
function setOnline(online) {
  const dot  = document.querySelector(".status-dot");
  const text = document.querySelector(".status-text");
  if (online) {
    dot.classList.add("online");
    text.textContent = "Live";
  } else {
    dot.classList.remove("online");
    text.textContent = "Offline";
  }
}

// -- Uptime --
function updateUptime() {
  const mins = Math.floor((Date.now() - startTime) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  document.getElementById("stat-uptime").textContent =
    h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// -- Time ago helper --
function timeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60)   return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  return Math.floor(sec / 3600) + "h ago";
}

/* ================================================================
   ALERT OVERLAY
   ================================================================ */
function showAlert(risk) {
  document.getElementById("alert-msg").textContent =
    `Risk score reached ${Math.round(risk)}! Immediate attention required.`;
  document.getElementById("alert-overlay").classList.add("active");
}

function dismissAlert() {
  document.getElementById("alert-overlay").classList.remove("active");
}

/* ================================================================
   EVENT LOG TABLE
   ================================================================ */
function buildEventLog(feeds) {
  const tbody = document.getElementById("event-log-body");
  tbody.innerHTML = "";

  // Show newest first
  const reversed = [...feeds].reverse();

  reversed.forEach((f, i) => {
    const state = parseInt(f.field5) || 0;
    const ack   = parseInt(f.field6) || 0;
    const sName = STATE_NAMES[state] || "?";
    const sCls  = STATE_CLASS[state] || "safe";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${feeds.length - i}</td>
      <td>${new Date(f.created_at).toLocaleTimeString()}</td>
      <td>${parseFloat(f.field1).toFixed(1) || "—"}</td>
      <td>${parseFloat(f.field2).toFixed(1) || "—"}</td>
      <td>${f.field3 || "—"}</td>
      <td>${f.field4 || "0"}</td>
      <td><span class="badge badge-${sCls}">${sName}</span></td>
      <td>${ack ? "✅" : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ================================================================
   CHARTS (Chart.js)
   ================================================================ */
function initCharts() {
  const shared = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(17,24,39,0.9)",
        titleColor: "#f1f5f9",
        bodyColor: "#94a3b8",
        borderColor: "rgba(148,163,184,0.15)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        titleFont: { family: "'Inter'", weight: 600 },
        bodyFont: { family: "'JetBrains Mono'" }
      }
    },
    scales: {
      x: {
        grid: { color: "rgba(148,163,184,0.06)" },
        ticks: { color: "#64748b", font: { size: 10 } }
      },
      y: {
        grid: { color: "rgba(148,163,184,0.06)" },
        ticks: { color: "#64748b", font: { size: 10 } }
      }
    }
  };

  chartTemp = new Chart(document.getElementById("chartTemp"), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Temperature",
        data: [],
        borderColor: "#f97316",
        backgroundColor: "rgba(249,115,22,0.08)",
        borderWidth: 2.5,
        pointRadius: 3,
        pointBackgroundColor: "#f97316",
        fill: true,
        tension: 0.4
      }]
    },
    options: { ...shared }
  });

  chartHum = new Chart(document.getElementById("chartHum"), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Humidity",
        data: [],
        borderColor: "#06b6d4",
        backgroundColor: "rgba(6,182,212,0.08)",
        borderWidth: 2.5,
        pointRadius: 3,
        pointBackgroundColor: "#06b6d4",
        fill: true,
        tension: 0.4
      }]
    },
    options: { ...shared }
  });

  chartRisk = new Chart(document.getElementById("chartRisk"), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Risk Score",
        data: [],
        borderColor: "#eab308",
        backgroundColor: "rgba(234,179,8,0.08)",
        borderWidth: 2.5,
        pointRadius: 3,
        pointBackgroundColor: "#eab308",
        fill: true,
        tension: 0.4
      }]
    },
    options: { ...shared }
  });
}

function updateChart(chart, labels, data) {
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.update("none");   // no animation on update for perf
}

/* ================================================================
   RISK GAUGE  (Canvas arc)
   ================================================================ */
function drawGauge(value) {
  const canvas = document.getElementById("riskGauge");
  const ctx    = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H - 10;
  const r  = 80;

  ctx.clearRect(0, 0, W, H);

  // background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI, false);
  ctx.lineWidth = 14;
  ctx.strokeStyle = "rgba(148,163,184,0.1)";
  ctx.lineCap = "round";
  ctx.stroke();

  // value arc
  const pct   = Math.min(value / 100, 1);
  const angle = Math.PI + pct * Math.PI;

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0,   "#22c55e");
  grad.addColorStop(0.4, "#eab308");
  grad.addColorStop(0.7, "#f97316");
  grad.addColorStop(1,   "#ef4444");

  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, angle, false);
  ctx.lineWidth = 14;
  ctx.strokeStyle = grad;
  ctx.lineCap = "round";
  ctx.stroke();

  // tick marks
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + (i / 10) * Math.PI;
    const x1 = cx + (r + 10) * Math.cos(a);
    const y1 = cy + (r + 10) * Math.sin(a);
    const x2 = cx + (r + 16) * Math.cos(a);
    const y2 = cy + (r + 16) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(148,163,184,0.2)";
    ctx.stroke();
  }

  // needle dot
  const nx = cx + (r - 20) * Math.cos(angle);
  const ny = cy + (r - 20) * Math.sin(angle);
  ctx.beginPath();
  ctx.arc(nx, ny, 4, 0, 2 * Math.PI);
  ctx.fillStyle = "#f1f5f9";
  ctx.fill();
}
