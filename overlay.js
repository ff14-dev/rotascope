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
  rotationCandidates: [],
  selectedRotationIndex: 0,
  timelineSlots: 7,
  skillLogMax: 20,
  showSkillLog: true,
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
  app:            document.getElementById("app"),
  player:         document.getElementById("player-label"),
  detectedJob:    document.getElementById("detected-job"),
  status:         document.getElementById("status-text"),
  logPrev:        document.getElementById("log-prev"),
  logNext:        document.getElementById("log-next"),
  logIndex:       document.getElementById("log-index"),
  timeline:       document.getElementById("timeline"),
  skillLog:       document.getElementById("skill-log"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsView:   document.getElementById("settings-view"),
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
  state.job       = String(params.get("job") || localStorage.getItem("rs_job") || "sam").toLowerCase();
  state.dataBase  = (params.get("base") || "").replace(/\/$/, "");
  state.report    = params.get("report");
  state.fight     = params.has("fight") ? Number(params.get("fight")) : null;
  if (params.get("log") === "1") state.logAttempts = true;
}

// ── 정적 파일 fetch 헬퍼 ─────────────────────────────────────────────────
function staticUrl(path) {
  const normalized = String(path || "").replace(/^\/+/, "");
  if (state.dataBase) {
    return `${state.dataBase.replace(/\/+$/, "")}/${normalized}`;
  }
  // GitHub Pages 프로젝트 경로(/<repo>/)에서도 동작하도록 상대경로 사용
  return `./${normalized}`;
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
  try {
    const candidatePaths = [
      `/data/rotations/${state.job}/${enc}.json`,
      `/data/rotations/${enc}.json`,
    ];
    let data = null;
    let loadedUrl = "";
    let lastErr = null;

    for (const p of candidatePaths) {
      const url = staticUrl(p);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} — ${url}`);
          continue;
        }
        data = await res.json();
        loadedUrl = url;
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!data) throw (lastErr || new Error("타임라인 JSON을 불러오지 못했습니다"));

    const rotations = Array.isArray(data.full_rotations) ? data.full_rotations : [];
    if (!rotations.length) throw new Error("full_rotations 데이터가 비어 있습니다");

    state.rotationCandidates = rotations.slice(0, 10);
    state.selectedRotationIndex = 0;
    if (state.report && state.fight !== null) {
      const foundIndex = state.rotationCandidates.findIndex(
        (r) => r.report_id === state.report && r.fight_id === state.fight
      );
      if (foundIndex >= 0) state.selectedRotationIndex = foundIndex;
    }
    applySelectedRotation(false);
    setStatus(`타임라인 로딩 완료 (${loadedUrl}) — 전투 시작 신호를 기다립니다.`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(`타임라인 불러오기 실패: ${err}`, "error");
  }
}

function applySelectedRotation(resetCombat = true) {
  if (!state.rotationCandidates.length) return;
  const idx = Math.min(
    Math.max(0, state.selectedRotationIndex),
    state.rotationCandidates.length - 1,
  );
  state.selectedRotationIndex = idx;
  const target = state.rotationCandidates[idx];
  state.timeline = (target.timeline || []).filter((e) => !shouldIgnoreAbility(e?.ability));
  if (els.player) {
    els.player.textContent = `${target.player || "Unknown"} · ${target.report_id} · fight ${target.fight_id}`;
  }
  renderLogPicker();
  if (resetCombat) {
    resetCombatState(`로그 ${idx + 1} 선택됨`);
  } else {
    renderTimelineWindow();
  }
}

function renderLogPicker() {
  const total = state.rotationCandidates.length || 1;
  const current = Math.min(state.selectedRotationIndex + 1, total);
  if (els.logIndex) els.logIndex.textContent = `${current} / ${total}`;
  if (els.logPrev) els.logPrev.disabled = current <= 1;
  if (els.logNext) els.logNext.disabled = current >= total;
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
  if (state.ignoredAbilitiesNormalized.has(normalizeAbilityName(name))) return true;
  // 영문명 → 한글명 변환 후에도 체크 (타임라인은 영문, 무시목록은 한글일 수 있음)
  const localized = state.skillNameMap[name];
  if (localized && state.ignoredAbilitiesNormalized.has(normalizeAbilityName(localized))) return true;
  return false;
}

// ── 타임라인 렌더링 ───────────────────────────────────────────────────────
function renderTimelineWindow() {
  if (!els.timeline) return;
  els.timeline.innerHTML = "";
  if (state.timeline.length === 0) return;

  const anchor     = state.startTs ? state.currentTimelineIndex : 0;
  const windowSize = Math.max(3, state.timelineSlots || 7);
  const before = Math.floor((windowSize - 1) / 2);
  let start = Math.max(0, anchor - before);
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
    label.textContent = localizedName(event.ability) || "-";
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
  // 카운트 중 선입력으로 전진한 인덱스는 유지 (리셋 안 함)
  renderTimelineWindow();
  setStatus("전투 시작 감지 — 타이머 동기화 완료!", "ok");
}

function resetCombatState(statusMsg = "초읽기를 기다립니다.") {
  stopCountdown(false);
  state.startTs = null;
  state.expectedIndex = 0;
  state.currentTimelineIndex = 0;
  state.skillLog = [];
  renderSkillLog();
  renderTimelineWindow();
  setStatus(statusMsg, "info");
}

function handleCombatEnd() {
  resetCombatState("전투 종료 — 타임라인 초기화 중...");
  fetchTimeline();
}

function findSkillIcon(abilityName) {
  return state.timeline.find((e) => abilityMatches(e.ability, abilityName))?.icon || null;
}

function renderSkillLog() {
  if (!els.skillLog) return;
  els.skillLog.innerHTML = "";
  const visibleLogs = state.skillLog.slice(-state.skillLogMax);
  visibleLogs.forEach(({ ability, icon }) => {
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

  // 스킬로그는 전투 전후 모두 표시
  state.skillLog.push({ ability: abilityName, icon: findSkillIcon(abilityName) });
  if (state.skillLog.length > state.skillLogMax) state.skillLog.shift();
  renderSkillLog();

  const expectedEntry = state.timeline[state.expectedIndex] || null;

  // 전투 시작 전(카운트다운 중): 첫 번째 예상 스킬과 일치할 때만 타임라인 전진, 나머지는 무시
  if (!state.startTs) {
    if (expectedEntry && abilityMatches(expectedEntry.ability, abilityName)) {
      state.expectedIndex += 1;
      state.currentTimelineIndex = Math.min(state.expectedIndex, Math.max(state.timeline.length - 1, 0));
      renderTimelineWindow();
      setStatus(`선입력 일치: ${abilityName}`, "ok");
    }
    return;
  }

  state.lastAbilityTs = Date.now();
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

// ── 직업 자동인식 (ZeffUI 방식) ──────────────────────────────────────────
// onPlayerChangedEvent: e.detail.job (소문자 string, 예: "sam")
// getCombatants:        combatants[0].Job (대문자 J, string, 예: "SAM")

async function applyDetectedJob(abbr) {
  if (!abbr) return;
  const lower = abbr.toLowerCase();
  if (lower === state.job) return;
  state.job = lower;
  localStorage.setItem("rs_job", lower);
  if (els.detectedJob) {
    els.detectedJob.textContent = lower.toUpperCase();
    els.detectedJob.classList.add("sp-job-active");
  }
  resetCombatState(`직업 변경: ${lower.toUpperCase()} — 스킬 데이터 로드 중...`);
  await fetchSkillNames();
  fetchTimeline();
}

// addOverlayListener("onPlayerChangedEvent") 콜백 — e.detail.job
function onPlayerChangedEvent(e) {
  const job = e?.detail?.job;
  if (job) applyDetectedJob(job);
}

// getCombatants 결과에서 플레이어 직업 추출 — combatants[0].Job
function getPlayerFromCombatants(data) {
  if (!data?.combatants?.length) return;
  const player = data.combatants[0];
  if (player?.Job) applyDetectedJob(player.Job);
}

// 오버레이 로드 시 이미 인게임이면 onPlayerChangedEvent가 오지 않으므로
// getCombatants 로 즉시 조회 (ZeffUI 동일 패턴)
function queryCurrentPlayer() {
  if (!window.callOverlayHandler) return;
  callOverlayHandler({ call: "getCombatants" })
    .then(getPlayerFromCombatants)
    .catch(() => {});
}

// ── 로컬 서버 WebSocket 폴백 ──────────────────────────────────────────────
function connectLocalActLogStream() {
  // ?base= 없이 http://로 직접 로드된 경우 현재 오리진을 사용
  const base = state.dataBase || (window.location.protocol === "http:" ? window.location.origin : "");
  if (!base) return;
  const wsUrl = base.replace(/^http/, "ws") + "/ws/act-log";
  let ws;

  const connect = () => {
    ws = new WebSocket(wsUrl);
    state.overlayWs = ws;

    ws.onopen = () => setStatus("로컬 서버 연결 완료 — 전투 시작 신호를 기다립니다.", "ok");

    ws.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === "ping") return;
        dispatchOverlayPayload(payload);
      } catch {}
    };

    ws.onclose = () => {
      setStatus("로컬 서버 연결 끊김 — 5초 후 재시도...", "warn");
      setTimeout(connect, 5000);
    };

    ws.onerror = () => ws.close();
  };

  connect();
}

// ── OverlayPlugin 바인딩 ──────────────────────────────────────────────────
function isLocalServer() {
  // ?base= 는 JSON 파일 위치일 뿐 — ACT 연결 방식과 무관
  // http://127.0.0.1 또는 localhost 로 직접 서빙될 때만 WS 로그 방식 사용
  const h = window.location.hostname;
  return h === "127.0.0.1" || h === "localhost";
}

function setupOverlayPlugin() {
  // 로컬 서버: WS 로그 파일 스트리밍 사용
  if (isLocalServer()) {
    connectLocalActLogStream();
    return;
  }

  // common.min.js (ngld OverlayPlugin) 가 addOverlayListener 를 제공
  if (!window.addOverlayListener) {
    setStatus("OverlayPlugin 없음 — ACT에서 URL로 로드해 주세요.", "warn");
    return;
  }

  addOverlayListener("LogLine",              handleOverlayEvent);
  addOverlayListener("ChatLog",              handleOverlayEvent);
  addOverlayListener("onLogEvent",           handleLegacyLogEvent);
  addOverlayListener("onPlayerChangedEvent", onPlayerChangedEvent);

  startOverlayEvents();
  setStatus("OverlayPlugin 연결 완료 — 전투 시작 신호를 기다립니다.", "ok");

  // 이미 인게임 상태일 경우 직업 즉시 조회
  queryCurrentPlayer();
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
  const setSettingsMode = (enabled) => {
    if (!els.app || !els.settingsToggle) return;
    els.app.classList.toggle("settings-mode", enabled);
    els.settingsToggle.classList.toggle("open", enabled);
    els.settingsToggle.textContent = enabled ? "닫기" : "⚙";
    els.settingsToggle.title = enabled ? "설정 닫기" : "설정";
  };

  const applySkillLogVisibility = (visible) => {
    state.showSkillLog = !!visible;
    localStorage.setItem("rs_show_skill_log", state.showSkillLog ? "1" : "0");
    if (els.app) els.app.classList.toggle("hide-skill-log", !state.showSkillLog);
  };

  // ── 층 버튼 선택 ─────────────────────────────────────────────────────────
  const encounterButtons = Array.from(document.querySelectorAll("[data-encounter]"));
  const syncEncounterButtons = () => {
    encounterButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.encounter === state.encounter);
    });
  };
  encounterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = String(btn.dataset.encounter || "").toLowerCase();
      if (!next || next === state.encounter) return;
      state.encounter = next;
      localStorage.setItem("rs_encounter", state.encounter);
      syncEncounterButtons();
      fetchTimeline();
      setStatus(`층 변경 적용: ${next.toUpperCase()}`, "info");
    });
  });
  syncEncounterButtons();

  if (els.logPrev) {
    els.logPrev.addEventListener("click", () => {
      if (state.selectedRotationIndex <= 0) return;
      state.selectedRotationIndex -= 1;
      applySelectedRotation(true);
    });
  }
  if (els.logNext) {
    els.logNext.addEventListener("click", () => {
      if (state.selectedRotationIndex >= state.rotationCandidates.length - 1) return;
      state.selectedRotationIndex += 1;
      applySelectedRotation(true);
    });
  }
  renderLogPicker();

  const slotButtons = Array.from(document.querySelectorAll("[data-timeline-slots]"));
  const syncSlotButtons = () => {
    slotButtons.forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.timelineSlots) === state.timelineSlots);
    });
  };
  const savedTimelineSlots = Number(localStorage.getItem("rs_timeline_slots") || "7");
  state.timelineSlots = [3, 5, 7].includes(savedTimelineSlots) ? savedTimelineSlots : 7;
  syncSlotButtons();
  slotButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = Number(btn.dataset.timelineSlots);
      if (![3, 5, 7].includes(next) || next === state.timelineSlots) return;
      state.timelineSlots = next;
      localStorage.setItem("rs_timeline_slots", String(next));
      syncSlotButtons();
      renderTimelineWindow();
      setStatus(`타임라인 칸 수: ${next}`, "info");
    });
  });

  const skillLogVisButtons = Array.from(document.querySelectorAll("[data-skill-log-visible]"));
  const syncSkillLogVisButtons = () => {
    skillLogVisButtons.forEach((btn) => {
      btn.classList.toggle(
        "active",
        (btn.dataset.skillLogVisible === "1") === state.showSkillLog,
      );
    });
  };
  applySkillLogVisibility(localStorage.getItem("rs_show_skill_log") !== "0");
  syncSkillLogVisButtons();
  skillLogVisButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const visible = btn.dataset.skillLogVisible === "1";
      if (visible === state.showSkillLog) return;
      applySkillLogVisibility(visible);
      syncSkillLogVisButtons();
      setStatus(visible ? "아래 로그 표시" : "아래 로그 숨김", "info");
    });
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

  const opacityDecBtn = document.getElementById("ctrl-opacity-dec");
  const opacityIncBtn = document.getElementById("ctrl-opacity-inc");
  const opacityValEl  = document.getElementById("ctrl-opacity-val");
  const nodeWDecBtn   = document.getElementById("ctrl-node-w-dec");
  const nodeWIncBtn   = document.getElementById("ctrl-node-w-inc");
  const nodeWValEl    = document.getElementById("ctrl-node-w-val");
  const nodeHDecBtn   = document.getElementById("ctrl-node-h-dec");
  const nodeHIncBtn   = document.getElementById("ctrl-node-h-inc");
  const nodeHValEl    = document.getElementById("ctrl-node-h-val");

  let opacityPct = Math.min(100, Math.max(0, Math.round(saved.opacity * 100)));
  let nodeW = Math.min(140, Math.max(52, Math.round(saved.nodeW)));
  let nodeH = Math.min(80, Math.max(28, Math.round(saved.nodeH)));

  const renderControlValues = () => {
    if (opacityValEl) opacityValEl.textContent = `${opacityPct}%`;
    if (nodeWValEl) nodeWValEl.textContent = String(nodeW);
    if (nodeHValEl) nodeHValEl.textContent = String(nodeH);
  };

  const commitOpacity = (silent = false) => {
    const v = opacityPct / 100;
    applyOpacity(v);
    localStorage.setItem("rs_opacity", v.toFixed(2));
    if (!silent) setStatus(`투명도 적용: ${opacityPct}%`, "info");
  };

  const commitNodeSize = (statusMsg, silent = false) => {
    applyNodeSize(nodeW, nodeH);
    localStorage.setItem("rs_node_w", String(nodeW));
    localStorage.setItem("rs_node_h", String(nodeH));
    if (!silent) setStatus(statusMsg, "info");
  };

  renderControlValues();
  commitOpacity(true);
  commitNodeSize("노드 크기 적용", true);

  if (opacityDecBtn) {
    opacityDecBtn.addEventListener("click", () => {
      opacityPct = Math.max(0, opacityPct - 5);
      renderControlValues();
      commitOpacity();
    });
  }
  if (opacityIncBtn) {
    opacityIncBtn.addEventListener("click", () => {
      opacityPct = Math.min(100, opacityPct + 5);
      renderControlValues();
      commitOpacity();
    });
  }
  if (nodeWDecBtn) {
    nodeWDecBtn.addEventListener("click", () => {
      nodeW = Math.max(52, nodeW - 4);
      renderControlValues();
      commitNodeSize(`X 적용: ${nodeW}`);
    });
  }
  if (nodeWIncBtn) {
    nodeWIncBtn.addEventListener("click", () => {
      nodeW = Math.min(140, nodeW + 4);
      renderControlValues();
      commitNodeSize(`X 적용: ${nodeW}`);
    });
  }
  if (nodeHDecBtn) {
    nodeHDecBtn.addEventListener("click", () => {
      nodeH = Math.max(28, nodeH - 4);
      renderControlValues();
      commitNodeSize(`Y 적용: ${nodeH}`);
    });
  }
  if (nodeHIncBtn) {
    nodeHIncBtn.addEventListener("click", () => {
      nodeH = Math.min(80, nodeH + 4);
      renderControlValues();
      commitNodeSize(`Y 적용: ${nodeH}`);
    });
  }

  // 새로고침 시 자동으로 설정 화면이 뜨지 않도록 항상 메인 화면으로 초기화
  let settingsMode = false;
  setSettingsMode(false);
  if (els.settingsToggle) {
    els.settingsToggle.addEventListener("click", () => {
      settingsMode = !settingsMode;
      setSettingsMode(settingsMode);
    });
  }
}

// ── 진입점 ────────────────────────────────────────────────────────────────
function main() {
  parseParams();
  initSettings();
  Promise.all([fetchSkillNames(), fetchOverlaySettings()]).finally(fetchTimeline);
  setupOverlayPlugin();
}

document.addEventListener("DOMContentLoaded", main);
