
//  Constants (X-series) 
const DEG_PER_TICK = 0.088;
const RPM_PER_UNIT = 0.229;
const PERCENT_PER_PWM_UNIT = 0.113;
const MA_PER_CURRENT_UNIT = 1.0;

// Socket.IO instance (
let socket = null;

// Connection state
let busConnected = false;
let busInfo = { port: null, baudrate: null, ids: [] };

// UI helpers 

function log(level, message) {
  const panel = document.getElementById("log-panel");
  if (!panel) return;

  const row = document.createElement("div");
  row.className = "log-line";

  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  const now = new Date();
  timeSpan.textContent = now.toLocaleTimeString();

  const levelSpan = document.createElement("span");
  levelSpan.className =
    "log-level " + (level === "error" ? "log-level-error" : "log-level-info");
  levelSpan.textContent = level.toUpperCase();

  const msgSpan = document.createElement("span");
  msgSpan.textContent = message;

  row.appendChild(timeSpan);
  row.appendChild(levelSpan);
  row.appendChild(msgSpan);

  panel.appendChild(row);
  panel.scrollTop = panel.scrollHeight;
}

function updateSocketStatus(text, ok) {
  const status = document.getElementById("backend-status");
  if (!status) return;
  status.textContent = text;
  status.classList.remove("status-ok", "status-error");
  if (ok === true) status.classList.add("status-ok");
  if (ok === false) status.classList.add("status-error");
}

function updateBusStatus() {
  const el = document.getElementById("bus-status");
  if (!el) return;
  if (!busConnected || !busInfo.port) {
    el.textContent = "Bus: not connected.";
    return;
  }
  const idsStr = (busInfo.ids || []).join(", ");
  el.textContent = `Bus: connected · ${busInfo.port} @ ${busInfo.baudrate} · IDs: ${idsStr}`;
}

// Socket.IO init

function initSocket() {
  try {
    if (typeof io === "undefined") {
      console.error("Socket.IO client library not loaded (io is undefined).");
      updateSocketStatus("Socket.IO client missing", false);
      log("error", "Socket.IO client library not loaded. Check network / static files.");
      return;
    }
    socket = io(); // same origin, /socket.io path
  } catch (err) {
    console.error("Error initialising Socket.IO:", err);
    updateSocketStatus("Socket.IO error – see console", false);
    log("error", "Error initialising Socket.IO client: " + err);
    return;
  }

  // Connection events
  socket.on("connect", () => {
    updateSocketStatus("Socket: connected", true);
    log("info", "Connected to backend via WebSocket");
    requestPorts();
  });

  socket.on("disconnect", () => {
    updateSocketStatus("Socket: disconnected", false);
    log("error", "Disconnected from backend");
  });

  socket.on("backend_error", (data) => {
    const message = (data && data.message) || "Backend error";
    updateSocketStatus("Socket: error – " + message, false);
    log("error", message);
  });

  socket.on("log", (data) => {
    log(data.level || "info", data.message || "");
  });

  // Serial port list
  socket.on("serial_ports", (data) => {
    const ports = (data && data.ports) || [];
    const select = document.getElementById("serial-port-select");
    if (!select) return;

    select.innerHTML = "";
    if (ports.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No serial ports detected";
      select.appendChild(opt);
      return;
    }

    ports.forEach((p, index) => {
      const opt = document.createElement("option");
      opt.value = p.device;
      opt.textContent = `${p.device} — ${p.description || "Serial port"}`;
      if (index === 0) opt.selected = true;
      select.appendChild(opt);
    });
  });

  // Scan result
  socket.on("scan_result", (data) => {
    const container = document.getElementById("scan-results");
    if (!container) return;

    const ids = data.ids || [];
    const msg = data.message || "";
    log("info", msg);

    container.innerHTML = "";
    if (ids.length === 0) {
      const span = document.createElement("span");
      span.className = "scan-placeholder";
      span.textContent = msg || "No servos detected.";
      container.appendChild(span);
      return;
    }

    ids.forEach((id) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "id-chip selected";
      chip.dataset.id = String(id);
      chip.textContent = `ID ${id}`;
      chip.addEventListener("click", () => {
        chip.classList.toggle("selected");
      });
      container.appendChild(chip);
    });
  });

  // Connect / disconnect
  socket.on("connect_result", (data) => {
    busConnected = !!data.connected;
    busInfo =
      data.info || {
        port: null,
        baudrate: null,
        ids: [],
      };
    const msg = data.message || (busConnected ? "Connected." : "Disconnected.");
    log(busConnected ? "info" : "error", msg);
    updateBusStatus();
  });

  // Telemetry & charts
  setupTelemetryHandlers();
}

// Telemetry

const charts = {
  1: { pos: null, vel: null },
  2: { pos: null, vel: null },
};

function makeTimeSeriesChart(ctx, label) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label,
          data: [],
          fill: false,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: {
          display: true,
          ticks: {
            font: { size: 10 },
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            font: { size: 10 },
          },
        },
      },
    },
  });
}

function initCharts() {
  [1, 2].forEach((id) => {
    const posCanvas = document.getElementById(`pos-chart-${id}`);
    const velCanvas = document.getElementById(`vel-chart-${id}`);
    if (posCanvas && velCanvas) {
      charts[id].pos = makeTimeSeriesChart(
        posCanvas.getContext("2d"),
        `ID ${id} Position [deg]`
      );
      charts[id].vel = makeTimeSeriesChart(
        velCanvas.getContext("2d"),
        `ID ${id} Velocity [RPM]`
      );
    }
  });
}

const MAX_SAMPLES = 300;

function updateChart(chart, tLabel, value) {
  const data = chart.data;
  data.labels.push(tLabel);
  data.datasets[0].data.push(value);
  if (data.labels.length > MAX_SAMPLES) {
    data.labels.shift();
    data.datasets[0].data.shift();
  }
  chart.update("none");
}

function setupTelemetryHandlers() {
  if (!socket) return;

  socket.on("telemetry", (payload) => {
    const timestamp = payload.timestamp || Date.now() / 1000;
    const tLabel = new Date(timestamp * 1000).toLocaleTimeString();
    const servos = payload.servos || {};

    Object.keys(servos).forEach((idStr) => {
      const id = parseInt(idStr, 10);
      const s = servos[id];

      if (!s || s.error) {
        if (s && s.error) {
          log("error", `ID ${id}: ${s.error}`);
        }
        return;
      }

      const posTicks = s.present_position ?? 0;
      const posDeg = posTicks * DEG_PER_TICK;

      const velUnit = s.present_velocity ?? 0;
      const velRpm = velUnit * RPM_PER_UNIT;

      const currentUnit = s.present_current ?? 0;
      const currentmA = currentUnit * MA_PER_CURRENT_UNIT;

      const pwmUnit = s.present_pwm ?? 0;
      const pwmPercent = pwmUnit * PERCENT_PER_PWM_UNIT;

      const torqueEnabled = s.torque_enabled ? "ON" : "OFF";
      const moving = s.moving ? "Yes" : "No";

      const modeNameEl = document.getElementById(`mode-name-${id}`);
      const movingEl = document.getElementById(`moving-${id}`);
      const posDegEl = document.getElementById(`pos-deg-${id}`);
      const posRawEl = document.getElementById(`pos-raw-${id}`);
      const velRpmEl = document.getElementById(`vel-rpm-${id}`);
      const currentEl = document.getElementById(`current-ma-${id}`);
      const pwmEl = document.getElementById(`pwm-percent-${id}`);
      const torqueCheckbox = document.querySelector(
        `.torque-toggle[data-servo-id="${id}"]`
      );

      if (modeNameEl)
        modeNameEl.textContent = `${s.operating_mode_name} (${torqueEnabled})`;
      if (movingEl) movingEl.textContent = moving;
      if (posDegEl) posDegEl.textContent = posDeg.toFixed(1);
      if (posRawEl) posRawEl.textContent = posTicks;
      if (velRpmEl) velRpmEl.textContent = velRpm.toFixed(2);
      if (currentEl) currentEl.textContent = currentmA.toFixed(0);
      if (pwmEl) pwmEl.textContent = pwmPercent.toFixed(1);
      if (torqueCheckbox) torqueCheckbox.checked = !!s.torque_enabled;

      if (charts[id]?.pos) {
        updateChart(charts[id].pos, tLabel, posDeg);
      }
      if (charts[id]?.vel) {
        updateChart(charts[id].vel, tLabel, velRpm);
      }
    });
  });
}

// Connection UI 

function requestPorts() {
  if (!socket) return;
  socket.emit("list_serial_ports");
}

function setupConnectionUI() {
  const refreshBtn = document.getElementById("refresh-ports-btn");
  const scanBtn = document.getElementById("scan-servos-btn");
  const connectBtn = document.getElementById("connect-btn");
  const disconnectBtn = document.getElementById("disconnect-btn");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }
      requestPorts();
      log("info", "Refreshing serial port list…");
    });
  }

  if (scanBtn) {
    scanBtn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }

      const portSelect = document.getElementById("serial-port-select");
      const baudSelect = document.getElementById("baudrate-select");
      const idMinInput = document.getElementById("scan-id-min");
      const idMaxInput = document.getElementById("scan-id-max");

      const port = portSelect ? portSelect.value : "";
      if (!port) {
        log("error", "Please select a serial port before scanning.");
        return;
      }

      const baudrate = baudSelect
        ? parseInt(baudSelect.value || "57600", 10)
        : 57600;
      const idMin = idMinInput
        ? parseInt(idMinInput.value || "1", 10)
        : 1;
      const idMax = idMaxInput
        ? parseInt(idMaxInput.value || "10", 10)
        : 10;

      socket.emit("scan_servos", {
        port,
        baudrate,
        idMin,
        idMax,
      });
      log(
        "info",
        `Scanning ${port} @ ${baudrate} for IDs ${idMin}-${idMax}…`
      );
    });
  }

  if (connectBtn) {
    connectBtn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }

      const portSelect = document.getElementById("serial-port-select");
      const baudSelect = document.getElementById("baudrate-select");
      const port = portSelect ? portSelect.value : "";
      if (!port) {
        log("error", "Please select a serial port before connecting.");
        return;
      }

      const baudrate = baudSelect
        ? parseInt(baudSelect.value || "57600", 10)
        : 57600;

      const chips = Array.from(
        document.querySelectorAll("#scan-results .id-chip.selected")
      );
      const ids = chips
        .map((chip) => parseInt(chip.dataset.id, 10))
        .filter((x) => !Number.isNaN(x));

      if (!ids.length) {
        log(
          "error",
          "Select at least one servo ID (from the scan results) before connecting."
        );
        return;
      }

      socket.emit("connect_servos", { port, baudrate, ids });
      log(
        "info",
        `Connecting to ${port} @ ${baudrate} with IDs: ${ids.join(", ")}…`
      );
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }
      socket.emit("disconnect_servos");
      log("info", "Disconnecting from Dynamixel bus…");
    });
  }
}

//  Servo UI 

function setupServoTabs() {
  const tabs = Array.from(document.querySelectorAll(".servo-tab"));
  const panels = Array.from(document.querySelectorAll(".servo-panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.target;
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = document.getElementById(targetId);
      if (panel) {
        panel.classList.add("active");
      }
    });
  });
}

function setupServoUI() {
  setupServoTabs();

  // Torque toggles
  document.querySelectorAll(".torque-toggle").forEach((el) => {
    el.addEventListener("change", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        el.checked = !el.checked;
        return;
      }
      const id = parseInt(el.dataset.servoId, 10);
      const enable = el.checked;
      socket.emit("set_torque", { id, enable });
    });
  });

  // Mode selects
  document.querySelectorAll(".mode-select").forEach((el) => {
    el.addEventListener("change", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }
      const id = parseInt(el.dataset.servoId, 10);
      const mode = parseInt(el.value, 10);
      socket.emit("set_operating_mode", { id, mode, autoTorque: true });
    });
  });

  // Apply gains buttons
  document.querySelectorAll(".apply-gains").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }
      const id = parseInt(btn.dataset.servoId, 10);
      const pP = parseInt(
        document.getElementById(`p-p-${id}`).value || "0",
        10
      );
      const pI = parseInt(
        document.getElementById(`p-i-${id}`).value || "0",
        10
      );
      const pD = parseInt(
        document.getElementById(`p-d-${id}`).value || "0",
        10
      );
      const vP = parseInt(
        document.getElementById(`v-p-${id}`).value || "0",
        10
      );
      const vI = parseInt(
        document.getElementById(`v-i-${id}`).value || "0",
        10
      );

      socket.emit("set_pid", {
        id,
        positionP: pP,
        positionI: pI,
        positionD: pD,
        velocityP: vP,
        velocityI: vI,
      });
    });
  });

  // Apply goals buttons
  document.querySelectorAll(".apply-goals").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!socket) {
        log("error", "Socket not initialised.");
        return;
      }

      const id = parseInt(btn.dataset.servoId, 10);

      const posDeg = parseFloat(
        document.getElementById(`goal-pos-deg-${id}`).value || "0"
      );
      const velRpm = parseFloat(
        document.getElementById(`goal-vel-rpm-${id}`).value || "0"
      );
      const currentmA = parseFloat(
        document.getElementById(`goal-current-ma-${id}`).value || "0"
      );
      const pwmPercent = parseFloat(
        document.getElementById(`goal-pwm-percent-${id}`).value || "0"
      );
      const profileVel = parseInt(
        document.getElementById(`profile-vel-unit-${id}`).value || "0",
        10
      );
      const profileAccel = parseInt(
        document.getElementById(`profile-accel-unit-${id}`).value || "0",
        10
      );

      const goalPosition = Math.round(posDeg / DEG_PER_TICK);
      const goalVelocity = Math.round(velRpm / RPM_PER_UNIT);
      const goalCurrent = Math.round(currentmA / MA_PER_CURRENT_UNIT);
      const goalPwm = Math.round(pwmPercent / PERCENT_PER_PWM_UNIT);

      socket.emit("set_goals", {
        id,
        goalPosition,
        goalVelocity,
        goalCurrent,
        goalPwm,
        profileVelocity: profileVel,
        profileAccel: profileAccel,
      });
    });
  });
}

//  Page tabs 
function setupPageTabs() {
  const tabs = Array.from(document.querySelectorAll(".page-tab"));
  const views = Array.from(document.querySelectorAll(".page"));

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.target;
      tabs.forEach((t) => t.classList.remove("active"));
      views.forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      const view = document.getElementById(targetId);
      if (view) {
        view.classList.add("active");
      }
      if (targetId === "view-ik") {
        initIkCanvas();
      }
    });
  });
}

// IK drawing page 

const TICKS_PER_RAD = (180 / Math.PI) / DEG_PER_TICK;

// DH Table
//  i | α_{i-1} | a_{i-1} | d_i | θ_i
//  1 |   0     |   0     |  0  | θ1
//  2 |   0     |  l1     |  0  | θ2
//  3 |   0     |  l2     |  0  | 0


const ikConfig = {
  // Link lengths (cm)
  L1: 15,   
  L2: 15,   

  joint1Id: 1,
  joint2Id: 2,

  // servo electrical zero offsets [deg]
  offset1Deg: 0,
  offset2Deg: 0,

  // elbow configuration
  elbowUp: false,

  // playback timing
  speedMs: 25,

  // joint limits [deg] relative to θ=0
  joint1MinDeg: -90,
  joint1MaxDeg: 90,
  joint2MinDeg: -90,
  joint2MaxDeg: 90,
};

let ikCanvas = null;
let ikCtx = null;
let ikCenterX = 0;
let ikCenterY = 0;
let ikScale = 1;      // pixels per physical unit
let ikPoints = [];
let ikIsDrawing = false;
let lastIkPose = null;
let ikInitialized = false;
let ikResize = null;

function ikScreenToCanvasPos(e) {
  const rect = ikCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function ikScreenToWorld(p) {
  // convert from pixel coords to world coords using scale
  const dx = p.x - ikCenterX;
  const dy = ikCenterY - p.y;
  return {
    x: dx / ikScale,
    y: dy / ikScale,
  };
}

// Forward kinematics 
function fk(q1, q2) {
  const { L1, L2 } = ikConfig;

  const x1 = L1 * Math.cos(q1);
  const y1 = L1 * Math.sin(q1);

  const x2 = x1 + L2 * Math.cos(q1 + q2);
  const y2 = y1 + L2 * Math.sin(q1 + q2);

  return { x1, y1, x2, y2 };
}

// Inverse kinematics
function ikSolvePoint(p) {
  const { x, y } = ikScreenToWorld(p);
  const { L1, L2 } = ikConfig;

  const r2 = x * x + y * y;
  const num = r2 - L1 * L1 - L2 * L2;
  const den = 2 * L1 * L2;
  let cos2 = num / den;

  if (cos2 < -1 || cos2 > 1) {
    return null;
  }

  cos2 = Math.max(-1, Math.min(1, cos2));
  let q2 = Math.acos(cos2);
  if (ikConfig.elbowUp) q2 = -q2;

  const k1 = L1 + L2 * Math.cos(q2);
  const k2 = L2 * Math.sin(q2);
  const q1 = Math.atan2(y, x) - Math.atan2(k2, k1);

  const q1Deg = (q1 * 180) / Math.PI;
  const q2Deg = (q2 * 180) / Math.PI;

  if (
    q1Deg < ikConfig.joint1MinDeg ||
    q1Deg > ikConfig.joint1MaxDeg ||
    q2Deg < ikConfig.joint2MinDeg ||
    q2Deg > ikConfig.joint2MaxDeg
  ) {
    return null;
  }

  return { q1, q2 };
}

function ikAnglesToTicks(q1, q2) {
  const deg1 = (q1 * 180) / Math.PI + ikConfig.offset1Deg;
  const deg2 = (q2 * 180) / Math.PI + ikConfig.offset2Deg;
  return {
    pos1: Math.round(deg1 / DEG_PER_TICK),
    pos2: Math.round(deg2 / DEG_PER_TICK),
  };
}

// Reachable workspace 
function drawWorkspaceBoundary() {
  if (!ikCtx) return;

  const n1 = 120;
  const n2 = 120;

  const j1min = (ikConfig.joint1MinDeg * Math.PI) / 180;
  const j1max = (ikConfig.joint1MaxDeg * Math.PI) / 180;
  const j2min = (ikConfig.joint2MinDeg * Math.PI) / 180;
  const j2max = (ikConfig.joint2MaxDeg * Math.PI) / 180;

  ikCtx.save();
  ikCtx.translate(ikCenterX, ikCenterY);
  ikCtx.fillStyle = "rgba(220, 38, 38, 0.3)"; //Change colour if you want too

  for (let i = 0; i <= n1; i++) {
    const t1 = i / n1;
    const q1 = j1min + (j1max - j1min) * t1;

    for (let j = 0; j <= n2; j++) {
      const t2 = j / n2;
      const q2 = j2min + (j2max - j2min) * t2;

      const { x2, y2 } = fk(q1, q2);
      const sx = ikScale * x2;
      const sy = ikScale * y2;

      ikCtx.beginPath();
      ikCtx.arc(sx, -sy, 1.0, 0, Math.PI * 2);
      ikCtx.fill();
    }
  }

  ikCtx.restore();
}

// Draw arm links + joints 
function drawManipulator(q1, q2) {
  if (!ikCtx) return;
  const { x1, y1, x2, y2 } = fk(q1, q2);

  const sx1 = ikScale * x1;
  const sy1 = ikScale * y1;
  const sx2 = ikScale * x2;
  const sy2 = ikScale * y2;

  ikCtx.save();
  ikCtx.translate(ikCenterX, ikCenterY);
  ikCtx.lineWidth = 3;
  ikCtx.strokeStyle = "#2563eb";
  ikCtx.fillStyle = "#111827";

  // Link 1
  ikCtx.beginPath();
  ikCtx.moveTo(0, 0);
  ikCtx.lineTo(sx1, -sy1);
  ikCtx.stroke();

  // Link 2
  ikCtx.beginPath();
  ikCtx.moveTo(sx1, -sy1);
  ikCtx.lineTo(sx2, -sy2);
  ikCtx.stroke();

  // Joints 
  [[0, 0], [sx1, sy1]].forEach(([x, y]) => {
    ikCtx.beginPath();
    ikCtx.arc(x, -y, 4, 0, Math.PI * 2);
    ikCtx.fillStyle = "#111827";
    ikCtx.fill();
  });

  // End-effector
  ikCtx.beginPath();
  ikCtx.arc(sx2, -sy2, 4, 0, Math.PI * 2);
  ikCtx.fillStyle = "#ef4444";
  ikCtx.fill();

  ikCtx.restore();
}

function redrawIkCanvas() {
  if (!ikCtx || !ikCanvas) return;
  const rect = ikCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  ikCtx.clearRect(0, 0, w, h);

  // reachable workspace
  drawWorkspaceBoundary();

  // base point
  ikCtx.save();
  ikCtx.translate(ikCenterX, ikCenterY);
  ikCtx.beginPath();
  ikCtx.arc(0, 0, 4, 0, Math.PI * 2);
  ikCtx.fillStyle = "#111827";
  ikCtx.fill();
  ikCtx.restore();

  // user path 
  if (ikPoints.length > 1) {
    ikCtx.beginPath();
    ikCtx.moveTo(ikPoints[0].x, ikPoints[0].y);
    for (let i = 1; i < ikPoints.length; i++) {
      ikCtx.lineTo(ikPoints[i].x, ikPoints[i].y);
    }
    ikCtx.strokeStyle = "#cc0000";
    ikCtx.lineWidth = 2;
    ikCtx.stroke();
  }

  if (lastIkPose) {
    drawManipulator(lastIkPose.q1, lastIkPose.q2);
  }
}

function initIkCanvas() {
  ikCanvas = document.getElementById("ik-canvas");
  if (!ikCanvas) return;
  ikCtx = ikCanvas.getContext("2d");

  if (!ikInitialized) {
    ikInitialized = true;

    ikResize = () => {
      const rect = ikCanvas.getBoundingClientRect();
      const width = rect.width || 400;
      const height = rect.height || 360;
      ikCanvas.width = width * window.devicePixelRatio;
      ikCanvas.height = height * window.devicePixelRatio;
      ikCtx.setTransform(
        window.devicePixelRatio,
        0,
        0,
        window.devicePixelRatio,
        0,
        0
      );
      ikCenterX = width / 2;
      ikCenterY = height / 2;

      //Scale of drawing image
      const maxReach = (ikConfig.L1 + ikConfig.L2) || 1;
      const available = 0.45 * Math.min(width, height);
      ikScale = available / maxReach;

      redrawIkCanvas();
    };

    ikResize();
    window.addEventListener("resize", () => {
      if (!ikCanvas || !ikResize) return;
      ikResize();
    });

    ikCanvas.addEventListener("mousedown", (e) => {
      ikIsDrawing = true;
      const p = ikScreenToCanvasPos(e);
      ikPoints = [p];
      const sol = ikSolvePoint(p);
      lastIkPose = sol || null;
      redrawIkCanvas();
    });

    ikCanvas.addEventListener("mousemove", (e) => {
      if (!ikIsDrawing) return;
      const p = ikScreenToCanvasPos(e);
      const last = ikPoints[ikPoints.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (Math.hypot(dx, dy) >= 4) {
        ikPoints.push(p);
        const sol = ikSolvePoint(p);
        lastIkPose = sol || lastIkPose;
        redrawIkCanvas();
      }
    });

    window.addEventListener("mouseup", () => {
      ikIsDrawing = false;
    });
  } else if (ikResize) {
    ikResize();
  }
}

function playIkTrajectory() {
  if (!socket) {
    log("error", "Socket not initialised.");
    return;
  }
  if (ikPoints.length < 2) {
    log("error", "Draw a path first.");
    return;
  }

  const dt = Math.max(5, parseInt(ikConfig.speedMs || 50, 10));
  let index = 0;

  function step() {
    if (index >= ikPoints.length) return;
    const p = ikPoints[index];
    const angles = ikSolvePoint(p);
    if (angles) {
      const ticks = ikAnglesToTicks(angles.q1, angles.q2);
      socket.emit("set_goals", {
        id: ikConfig.joint1Id,
        goalPosition: ticks.pos1,
      });
      socket.emit("set_goals", {
        id: ikConfig.joint2Id,
        goalPosition: ticks.pos2,
      });
      lastIkPose = angles;
      redrawIkCanvas();
    } else {
      log("error", "IK failed for a point; skipping.");
    }

    index += 1;
    if (index < ikPoints.length) {
      setTimeout(step, dt);
    }
  }

  log(
    "info",
    `Playing IK trajectory with ${ikPoints.length} points at ~${(
      1000 / dt
    ).toFixed(1)} Hz`
  );
  step();
}

function setupIKUI() {
  const l1Input = document.getElementById("ik-l1");
  const l2Input = document.getElementById("ik-l2");
  const id1Input = document.getElementById("ik-id1");
  const id2Input = document.getElementById("ik-id2");
  const off1Input = document.getElementById("ik-off1");
  const off2Input = document.getElementById("ik-off2");
  const speedInput = document.getElementById("ik-speed");
  const elbowCheck = document.getElementById("ik-elbow-up");

  if (l1Input) l1Input.value = ikConfig.L1;
  if (l2Input) l2Input.value = ikConfig.L2;
  if (id1Input) id1Input.value = ikConfig.joint1Id;
  if (id2Input) id2Input.value = ikConfig.joint2Id;
  if (off1Input) off1Input.value = ikConfig.offset1Deg;
  if (off2Input) off2Input.value = ikConfig.offset2Deg;
  if (speedInput) speedInput.value = ikConfig.speedMs;
  if (elbowCheck) elbowCheck.checked = ikConfig.elbowUp;

  const applyBtn = document.getElementById("ik-apply");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      ikConfig.L1 = parseFloat(l1Input.value || "15");
      ikConfig.L2 = parseFloat(l2Input.value || "15");
      ikConfig.joint1Id = parseInt(id1Input.value || "1", 10);
      ikConfig.joint2Id = parseInt(id2Input.value || "2", 10);
      ikConfig.offset1Deg = parseFloat(off1Input.value || "0");
      ikConfig.offset2Deg = parseFloat(off2Input.value || "0");
      ikConfig.speedMs = parseInt(speedInput.value || "50", 10);
      ikConfig.elbowUp = elbowCheck.checked;

      if (ikResize) ikResize();
      else redrawIkCanvas();
      log("info", "Updated IK configuration.");
    });
  }

  const clearBtn = document.getElementById("ik-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      ikPoints = [];
      lastIkPose = null;
      redrawIkCanvas();
    });
  }

  const playBtn = document.getElementById("ik-play");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      playIkTrajectory();
    });
  }
}

// Boot

window.addEventListener("DOMContentLoaded", () => {
  initCharts();
  setupConnectionUI();
  setupServoUI();
  setupPageTabs();
  setupIKUI();
  initSocket();
});
