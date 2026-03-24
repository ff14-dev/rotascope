// ── 보스 표시명 ───────────────────────────────────────────────────────────
const ENCOUNTER_LABELS = {
  "M9S":    "M9S — Vamp Fatale",
  "M10S":   "M10S — Red Hot & Deep Blue",
  "M11S":   "M11S — The Tyrant",
  "M12S-P1":"M12S — Lindwurm (Phase 1)",
  "M12S-P2":"M12S — Lindwurm II (Phase 2)",
};

// ── FFXIV 직업 ID → 약어 ──────────────────────────────────────────────────
// onPlayerChangedEvent.detail.job 이 숫자일 때 사용
const FFXIV_JOB_BY_ID = {
  19:"pld", 20:"mnk", 21:"war", 22:"drg", 23:"brd",
  24:"whm", 25:"blm", 27:"smn", 28:"sch", 30:"nin",
  31:"mch", 32:"drk", 33:"ast", 34:"sam", 35:"rdm",
  37:"gnb", 38:"dnc", 39:"rpr", 40:"sge", 41:"vpr", 42:"pct",
};

const state = {
  encounter: "m9s",
  job: "sam",
  report: null,
  fight: null,
  // dataBase: 정적 JSON 파일의 베이스 URL
  //   - 비어 있으면 같은 오리진(로컬 / GitHub Pages 루트)
  //   - 예) "https://user.github.io/rotascope"
  dataBase: "",
  timeline: [],
  startTs: null,
  lastAbilityTs: 0,
  expectedIndex: 0,
  logAttempts: false,          // 서버 없으므로 기본 비활성
  countdownTimerId: null,
  countdownTargetTs: null,
  lastCountdownSignalAt: 0,
  lastCountdownSeconds: null,
  skillLog: [],
  skillNameMap: {},
  skillNameReverseMap: {},
  ignoredAbilitiesNormalized: new Set(),
  currentTimelineIndex: 0,
  overlayWs: null,
};

// ── 이벤트 중복 제거 ──────────────────────────────────────────────────────
const _seenEventKeys = new Map();
const DEDUP_WINDOW_MS = 500;

function isDuplicateEvent(parts) {
  if (!Array.isArray(parts) || parts.length < 3) return false;
  const key = `${parts[0]}|${parts[1]}|${parts[2]}`;
  const now = Date.now();
  if (_seenEventKeys.has(key) && now - _seenEventKeys.get(key) < DEDUP_WINDOW_MS) return true;
  _seenEventKeys.set(key, now);
  if (_seenEventKeys.size > 100) {
    const cutoff = now - DEDUP_WINDOW_MS * 4;
    for (const [k, t] of _seenEventKeys) if (t < cutoff) _seenEventKeys.delete(k);
  }
  return false;
}

const els = {
  player:         document.getElementById("player-label"),
  detectedJob:    document.getElementById("detected-job"),
  status:         document.getElementById("status-text"),
  timeline:       document.getElementById("timeline"),
  skillLog:       document.getElementById("skill-log"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel:  document.getElementById("settings-panel"),
};

// ── URL 파라미터 ──────────────────────────────────────────────────────────
// 지원 파라미터:
//   encounter=m9s         보스 키 (소문자)
//   job=sam               직업 약어
//   base=https://...      정적 파일 베이스 URL (기본: 같은 오리진)
//   report=ABC123         특정 report 포커스
//   fight=5               특정 fight 포커스
//   log=1                 시도 기록 활성화 (서버 없으면 무시됨)
function parseParams() {
  const params = new URLSearchParams(window.location.search);
  state.encounter = (
    params.get("encounter") ||
    localStorage.getItem("rs_encounter") ||
    state.encounter
  ).toLowerCase();
  state.job       = params.get("job") || localStorage.getItem("rs_job") || "sam";
  state.dataBase  = (params.get("base") || "").replace(/\/$/, "");
  state.report    = params.get("report");
  state.fight     = params.has("fight") ? Number(params.get("fight")) : null;
  if (params.get("log") === "1") state.logAttempts = true;
}

// ── 정적 파일 fetch 헬퍼 ─────────────────────────────────────────────────
function staticUrl(path) {
  // path 는 항상 / 로 시작
  return state.dataBase + path;
}

// ── 스킬명 로드 (configs/skill_name_overrides_{job}.json) ─────────────────
async function fetchSkillNames() {
  try {
    const url = staticUrl(`/configs/skill_name_overrides_${state.job}.json`);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    // data 는 {"Gyofu": "검풍", ...} 형식
    const names = typeof data.names === "object" ? data.names : data;
    state.skillNameMap = names;
    state.skillNameReverseMap = {};
    Object.entries(names).forEach(([en, ko]) => {
      if (typeof ko === "string" && ko) state.skillNameReverseMap[ko] = en;
    });
  } catch {}
}

// ── 오버레이 설정 로드 (configs/overlay_settings.json) ───────────────────
async function fetchOverlaySettings() {
  try {
    const url = staticUrl("/configs/overlay_settings.json");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const ignored = Array.isArray(data.ignored_abilities) ? data.ignored_abilities : [];
    state.ignoredAbilitiesNormalized = new Set(ignored.map(normalizeAbilityName).filter(Boolean));
  } catch {}
}

// ── 타임라인 로드 (data/rotations/{job}/{encounter}.json) ─────────────────
async function fetchTimeline() {
  const enc = state.encounter.toLowerCase();
  const url = staticUrl(`/data/rotations/${state.job}/${enc}.json`);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    const data = await res.json();

    const rotations = Array.isArray(data.full_rotations) ? data.full_rotations : [];
    if (!rotations.length) throw new Error("full_rotations 데이터가 비어 있습니다");

    // report/fight 파라미터가 있으면 해당 항목, 없으면 첫 번째
    let target = rotations[0];
    if (state.report && state.fight !== null) {
      const found = rotations.find(
        (r) => r.report_id === state.report && r.fight_id === state.fight
      );
      if (found) target = found;
    }

    state.timeline = (target.timeline || []).filter((e) => !shouldIgnoreAbility(e?.ability));

    const encKey = enc.replace(/-/g, "-").toUpperCase();
    if (els.player) els.player.textContent = `${target.player || "Unknown"} · ${target.report_id} · fight ${target.fight_id}`;

    renderTimelineWindow();
    setStatus("타임라인 로딩 완료 — 전투 시작 신호를 기다립니다.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(`타임라인 불러오기 실패: ${err}`, "error");
  }
}

// ── 스킬명 처리 ───────────────────────────────────────────────────────────
function localizedName(abilityName) {
  if (isPotionAlias(abilityName)) return "탕약";
  return state.skillNameMap[abilityName] || abilityName;
}

function normalizeAbilityName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

function isPotionAlias(name) {
  const n = normalizeAbilityName(name);
  if (!n) return false;
  return n.startsWith("ability") || n.startsWith("item") ||
         n.includes("탕약") || n.includes("tincture") || n.includes("potion");
}

function abilityAliases(name) {
  const raw = String(name || "");
  if (isPotionAlias(raw)) return ["__potion__"];
  const mapped  = state.skillNameMap[raw] || raw;
  const reverse = state.skillNameReverseMap[raw] || raw;
  return [raw, mapped, reverse].map(normalizeAbilityName).filter(Boolean);
}

function abilityMatches(left, right) {
  const leftSet = new Set(abilityAliases(left));
  for (const token of abilityAliases(right)) if (leftSet.has(token)) return true;
  return false;
}

function shouldIgnoreAbility(name) {
  return state.ignoredAbilitiesNormalized.has(normalizeAbilityName(name));
}

// ── 타임라인 렌더링 ───────────────────────────────────────────────────────
const WINDOW_BEFORE = 2;
const WINDOW_AFTER  = 4;

function renderTimelineWindow() {
  if (!els.timeline) return;
  els.timeline.innerHTML = "";
  if (state.timeline.length === 0) return;

  const anchor     = state.startTs ? state.currentTimelineIndex : 0;
  const windowSize = WINDOW_BEFORE + WINDOW_AFTER + 1;
  let start = Math.max(0, anchor - WINDOW_BEFORE);
  let end   = Math.min(state.timeline.length, start + windowSize);
  start = Math.max(0, end - windowSize);

  for (let idx = start; idx < end; idx++) {
    const event = state.timeline[idx];
    const node  = document.createElement("div");
    node.className = "node";
    if (idx < anchor)   node.classList.add("past");
    if (idx === anchor) node.classList.add("current");
    if (idx > anchor)   node.classList.add("future");

    if (event.icon) {
      const img = document.createElement("img");
      img.src = event.icon;
      img.alt = event.ability || "";
      node.appendChild(img);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "node-fallback";
      fallback.textContent = (event.ability || "?").slice(0, 2);
      node.appendChild(fallback);
    }

    const time = document.createElement("div");
    time.textContent = `${Number(event.t || 0).toFixed(1)}s`;
    node.appendChild(time);

    const label = document.createElement("div");
    label.textContent = event.ability || "-";
    node.appendChild(label);

    if (state.startTs) {
      const marker = document.createElement("div");
      marker.className = "node-marker";
      if (idx === anchor)    marker.textContent = "NOW";
      else if (idx > anchor) marker.textContent = `+${idx - anchor}`;
      else                   marker.textContent = `${idx - anchor}`;
      node.appendChild(marker);
    }

    node.addEventListener("click", () => {
      state.currentTimelineIndex = idx;
      state.expectedIndex = Math.min(idx + 1, state.timeline.length);
      renderTimelineWindow();
      setStatus(`선택: ${event.ability || "-"}`, "info");
    });

    els.timeline.appendChild(node);
  }
}

function setStatus(message, type = "info") {
  els.status.textContent  = message;
  els.status.dataset.type = type;
}

// ── 전투 이벤트 ───────────────────────────────────────────────────────────
function handleCombatStart(ts) {
  stopCountdown(false);
  if (state.startTs) return;
  state.startTs = ts;
  state.lastAbilityTs = 0;
  state.expectedIndex = 0;
  state.currentTimelineIndex = 0;
  renderTimelineWindow();
  setStatus("전투 시작 감지 — 타이머 동기화 완료!", "ok");
}

function handleCombatEnd() {
  stopCountdown(false);
  state.startTs = null;
  state.expectedIndex = 0;
  state.currentTimelineIndex = 0;
  state.skillLog = [];
  renderSkillLog();
  renderTimelineWindow();
  setStatus("전투 종료 — 다시 시작하면 자동으로 갱신됩니다.", "info");
}

function findSkillIcon(abilityName) {
  return state.timeline.find((e) => abilityMatches(e.ability, abilityName))?.icon || null;
}

function renderSkillLog() {
  if (!els.skillLog) return;
  els.skillLog.innerHTML = "";
  state.skillLog.forEach(({ ability, icon }) => {
    const entry = document.createElement("div");
    entry.className = "skill-entry";
    if (icon) {
      const img = document.createElement("img");
      img.src = icon; img.alt = ability;
      entry.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "skill-no-icon";
      ph.textContent = ability.slice(0, 2);
      entry.appendChild(ph);
    }
    const label = document.createElement("span");
    label.textContent = ability;
    entry.appendChild(label);
    entry.addEventListener("click", () => {
      const idx = state.timeline.findIndex((e) => abilityMatches(e.ability, ability));
      if (idx >= 0) {
        state.currentTimelineIndex = idx;
        state.expectedIndex = Math.min(idx + 1, state.timeline.length);
        renderTimelineWindow();
        setStatus(`입력 스킬 기준 이동: ${ability}`, "info");
      }
    });
    els.skillLog.appendChild(entry);
  });
}

const AUTO_ATTACK_NAMES = new Set(["Attack", "Shot", "공격"]);

function handleAbility(logLine) {
  const rawAbilityName = logLine[5];
  if (!rawAbilityName || AUTO_ATTACK_NAMES.has(rawAbilityName) || shouldIgnoreAbility(rawAbilityName)) return;
  const abilityName = localizedName(rawAbilityName);

  state.skillLog.push({ ability: abilityName, icon: findSkillIcon(abilityName) });
  if (state.skillLog.length > 8) state.skillLog.shift();
  renderSkillLog();

  if (!state.startTs) return;
  state.lastAbilityTs = Date.now();
  const elapsed       = (Date.now() - state.startTs) / 1000;
  const expectedEntry = state.timeline[state.expectedIndex] || null;
  let matched = false;
  let matchedIndex = -1;

  if (expectedEntry && abilityMatches(expectedEntry.ability, abilityName)) {
    matched = true;
    matchedIndex = state.expectedIndex;
    state.expectedIndex += 1;
  } else if (state.timeline.length > 0) {
    state.expectedIndex = Math.min(state.expectedIndex + 1, state.timeline.length);
    matchedIndex = state.expectedIndex;
  }

  if (matchedIndex >= 0) {
    state.currentTimelineIndex = Math.min(state.expectedIndex, Math.max(state.timeline.length - 1, 0));
    renderTimelineWindow();
  }

  setStatus(
    matched
      ? `일치: ${abilityName}`
      : `불일치: ${abilityName} (예상: ${expectedEntry?.ability || "-"})`,
    matched ? "ok" : "warn"
  );
}

// ── ACT 카운트다운 자동 감지 ──────────────────────────────────────────────
function buildLogText(event, line) {
  const parts = [];
  if (Array.isArray(line)) parts.push(line.join("|"));
  if (typeof event?.rawLine === "string") parts.push(event.rawLine);
  return parts.join(" ");
}

function detectCountdownSeconds(event, line) {
  const text = buildLogText(event, line).replace(/\s+/g, " ");
  const patterns = [
    /전투\s*시작까지\s*(\d{1,2})\s*초/i,
    /전투\s*개시까지\s*(\d{1,2})\s*초/i,
    /(\d{1,2})\s*초\s*후\s*전투\s*시작/i,
    /전투\s*시작.*?(\d{1,2})\s*초/i,
    /초읽기.*?(\d{1,2})\s*초?/i,
    /카운트다운.*?(\d{1,2})\s*초?/i,
    /\/(?:cd|countdown)\s+(\d{1,2})\b/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const seconds = Number(m[1]);
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60) return seconds;
  }
  return null;
}

function isCountdownCancelled(event, line) {
  const text = buildLogText(event, line).replace(/\s+/g, " ");
  return /카운트다운.*취소/i.test(text) || /초읽기.*취소/i.test(text) ||
         /전투\s*준비.*취소/i.test(text) || /countdown cancelled/i.test(text);
}

function handleAutoCountdown(seconds) {
  const now = Date.now();
  if (state.lastCountdownSeconds === seconds && now - state.lastCountdownSignalAt < 1200) return;
  state.lastCountdownSignalAt = now;
  state.lastCountdownSeconds  = seconds;
  startCountdown(seconds);
  setStatus(`ACT 초읽기 감지: ${seconds}초`, "info");
}

function stopCountdown(showMessage = true) {
  if (state.countdownTimerId) { clearInterval(state.countdownTimerId); state.countdownTimerId = null; }
  state.countdownTargetTs = null;
  if (showMessage) setStatus("카운트다운 취소됨.", "warn");
}

function startCountdown(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(1, Math.min(60, Math.floor(seconds))) : 15;
  stopCountdown(false);
  state.countdownTargetTs = Date.now() + safeSeconds * 1000;
  const tick = () => {
    if (!state.countdownTargetTs) return;
    const remainMs = state.countdownTargetTs - Date.now();
    if (remainMs <= 0) {
      stopCountdown(false);
      handleCombatStart(Date.now());
      setStatus("카운트다운 완료 — 전투 시작!", "ok");
      return;
    }
    setStatus(`카운트다운: ${Math.ceil(remainMs / 1000)}초`, "info");
  };
  tick();
  state.countdownTimerId = setInterval(tick, 250);
}

// ── 로그 이벤트 처리 ──────────────────────────────────────────────────────
function handleOverlayEvent(event) {
  const line = Array.isArray(event?.line) ? event.line : [];
  const type = Number(line[0]);

  const countdownSeconds = detectCountdownSeconds(event, line);
  if (countdownSeconds !== null) {
    handleAutoCountdown(countdownSeconds);
  } else if (isCountdownCancelled(event, line)) {
    stopCountdown(false);
    setStatus("ACT 초읽기 취소 감지.", "warn");
  }

  switch (type) {
    case 21: case 22: handleAbility(line); break;
    case 26: if (!state.countdownTargetTs) handleCombatStart(Date.now()); break;
    case 33: handleCombatEnd(); break;
  }
}

function handleLegacyLogEvent(event) {
  const logs = Array.isArray(event?.logs) ? event.logs
    : Array.isArray(event?.detail?.logs) ? event.detail.logs : [];
  for (const raw of logs) {
    const rawText = String(raw || "");
    if (!rawText) continue;
    handleOverlayEvent({ type: "onLogEvent", rawLine: rawText, line: rawText.split("|") });
  }
}

function dispatchOverlayPayload(payload) {
  if (!payload) return;
  if (payload.type === "onLogEvent" || payload.logs || payload?.detail?.logs) {
    handleLegacyLogEvent(payload); return;
  }
  if (payload.msgtype && payload.msg) {
    const bridged = typeof payload.msg === "object"
      ? { ...payload.msg, type: payload.msgtype }
      : { type: payload.msgtype, rawLine: String(payload.msg) };
    dispatchOverlayPayload(bridged); return;
  }
  if (payload.line || payload.rawLine || payload.type) {
    const line = Array.isArray(payload.line) ? payload.line : [];
    if (line.length >= 3 && isDuplicateEvent(line)) return;
    handleOverlayEvent(payload);
  }
}

// ── 직업 자동인식 ─────────────────────────────────────────────────────────
function jobAbbrFromDetail(detail) {
  if (!detail) return null;
  const j = detail.job;
  // 신버전 OverlayPlugin: job 이 "SAM" 같은 문자열
  if (typeof j === "string" && j.length >= 2) return j.toLowerCase();
  // 구버전: job 이 숫자 ID
  if (typeof j === "number") return FFXIV_JOB_BY_ID[j] || null;
  return null;
}

async function handlePlayerChanged(detail) {
  const abbr = jobAbbrFromDetail(detail);
  if (!abbr) return;
  if (abbr === state.job) return;
  state.job = abbr;
  localStorage.setItem("rs_job", abbr);
  if (els.detectedJob) {
    els.detectedJob.textContent = abbr.toUpperCase();
    els.detectedJob.classList.add("sp-job-active");
  }
  await fetchSkillNames();
  fetchTimeline();
}

// ── OverlayPlugin 바인딩 ──────────────────────────────────────────────────
function setupOverlayPlugin() {
  if (!window.OverlayPluginApi) {
    setStatus("OverlayPlugin 없음 — ACT에서 URL로 로드해 주세요.", "warn");
    return;
  }
  const addListenerCompat = (name, cb) => {
    if (window.addOverlayListener) { window.addOverlayListener(name, cb); return; }
    document.addEventListener(name, (evt) => cb(evt && "detail" in evt ? evt.detail : evt));
  };
  const startEventsCompat = async () => {
    if (window.startOverlayEvents) { window.startOverlayEvents(); return; }
    if (window.callOverlayHandler) try {
      await window.callOverlayHandler({ call: "subscribe", events: ["LogLine", "ChatLog", "onLogEvent", "onPlayerChangedEvent"] });
    } catch {}
  };
  const bindListeners = async () => {
    addListenerCompat("LogLine",              handleOverlayEvent);
    addListenerCompat("ChatLog",              handleOverlayEvent);
    addListenerCompat("onLogEvent",           handleLegacyLogEvent);
    addListenerCompat("onPlayerChangedEvent", (e) => {
      handlePlayerChanged(e?.detail || e);
    });
    await startEventsCompat();
    setStatus("OverlayPlugin 연결 완료 — 전투 시작 신호를 기다립니다.", "ok");
  };
  if (window.OverlayPluginApi?.ready?.then) window.OverlayPluginApi.ready.then(bindListeners);
  else bindListeners();
}

// ── 설정 패널 (투명도 / X·Y 크기) ────────────────────────────────────────
function applyOpacity(val) {
  document.documentElement.style.setProperty("--app-opacity", val);
}

function applyNodeSize(w, h) {
  document.documentElement.style.setProperty("--node-w",    w + "px");
  document.documentElement.style.setProperty("--node-icon", h + "px");
}

function initSettings() {
  // ── 보스 선택 드롭다운 ──────────────────────────────────────────────────
  const encounterSelect = document.getElementById("ctrl-encounter");
  Object.entries(ENCOUNTER_LABELS).forEach(([key, label]) => {
    const opt = document.createElement("option");
    opt.value = key.toLowerCase();
    opt.textContent = label;
    encounterSelect.appendChild(opt);
  });
  encounterSelect.value = state.encounter;
  encounterSelect.addEventListener("change", () => {
    state.encounter = encounterSelect.value;
    localStorage.setItem("rs_encounter", state.encounter);
    fetchTimeline();
  });

  // ── 직업 표시 초기화 ────────────────────────────────────────────────────
  if (els.detectedJob) {
    els.detectedJob.textContent = state.job.toUpperCase();
    els.detectedJob.classList.toggle("sp-job-active", state.job !== "sam" || !!localStorage.getItem("rs_job"));
  }

  const saved = {
    opacity: parseFloat(localStorage.getItem("rs_opacity") ?? "0.65"),
    nodeW:   parseInt(localStorage.getItem("rs_node_w")   ?? "72",  10),
    nodeH:   parseInt(localStorage.getItem("rs_node_h")   ?? "48",  10),
  };

  const opacityInput = document.getElementById("ctrl-opacity");
  const opacityVal   = document.getElementById("ctrl-opacity-val");
  const nodeWInput   = document.getElementById("ctrl-node-w");
  const nodeWVal     = document.getElementById("ctrl-node-w-val");
  const nodeHInput   = document.getElementById("ctrl-node-h");
  const nodeHVal     = document.getElementById("ctrl-node-h-val");

  applyOpacity(saved.opacity);
  applyNodeSize(saved.nodeW, saved.nodeH);
  opacityInput.value     = saved.opacity;
  opacityVal.textContent = Math.round(saved.opacity * 100) + "%";
  nodeWInput.value       = saved.nodeW;
  nodeWVal.textContent   = saved.nodeW;
  nodeHInput.value       = saved.nodeH;
  nodeHVal.textContent   = saved.nodeH;

  opacityInput.addEventListener("input", () => {
    const v = parseFloat(opacityInput.value);
    applyOpacity(v);
    opacityVal.textContent = Math.round(v * 100) + "%";
    localStorage.setItem("rs_opacity", v);
  });
  nodeWInput.addEventListener("input", () => {
    const w = parseInt(nodeWInput.value, 10);
    applyNodeSize(w, parseInt(nodeHInput.value, 10));
    nodeWVal.textContent = w;
    localStorage.setItem("rs_node_w", w);
  });
  nodeHInput.addEventListener("input", () => {
    const h = parseInt(nodeHInput.value, 10);
    applyNodeSize(parseInt(nodeWInput.value, 10), h);
    nodeHVal.textContent = h;
    localStorage.setItem("rs_node_h", h);
  });

  els.settingsToggle.addEventListener("click", () => {
    const hidden = els.settingsPanel.classList.toggle("hidden");
    els.settingsToggle.classList.toggle("open", !hidden);
  });
  document.addEventListener("click", (e) => {
    if (!els.settingsPanel.classList.contains("hidden") &&
        !els.settingsPanel.contains(e.target) &&
        e.target !== els.settingsToggle) {
      els.settingsPanel.classList.add("hidden");
      els.settingsToggle.classList.remove("open");
    }
  });
}

// ── 진입점 ────────────────────────────────────────────────────────────────
function main() {
  parseParams();
  initSettings();
  Promise.all([fetchSkillNames(), fetchOverlaySettings()]).finally(fetchTimeline);
  setupOverlayPlugin();
}

document.addEventListener("DOMContentLoaded", main);
