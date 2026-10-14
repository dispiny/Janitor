import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";

const $ = (id) => document.getElementById(id);

const state = {
  view: "dashboard",
  filter: "all",
  svcFilter: "all",
  svcQuery: "",
  editingServiceId: null,
  wol: "manual",
  config: null,
  sb: null,
  session: null,
  house: null,
  membershipRole: null,
  members: [],
  servers: [],
  services: [],
  guests: [],
  speeds: [],
};

function isOwner() {
  return state.membershipRole === "owner";
}

function isSafeHttpUrl(raw) {
  const value = (raw || "").trim();
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "metadata.google.internal" || host === "metadata.goog" || host === "metadata") return false;
  if (/^169\.254\./.test(host)) return false;
  return true;
}

function showToast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 2800);
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.session?.access_token) {
    headers.Authorization = `Bearer ${state.session.access_token}`;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function relativeTime(iso) {
  if (!iso) return "아직 없음";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "방금";
  if (ms < 3_600_000) return `약 ${Math.floor(ms / 60_000)}분 전`;
  if (ms < 86_400_000) return `약 ${Math.floor(ms / 3_600_000)}시간 전`;
  return new Date(iso).toLocaleString("ko-KR");
}

function canWake(server) {
  return server.wol.mode === "manual" && Boolean(server.wol.mac);
}

function wolLabel(server) {
  if (!canWake(server)) return "WOL 없음";
  const target = server.wol.broadcast || "255.255.255.255";
  return `WOL ${server.wol.mac} → ${target}:${server.wol.port || 9}`;
}

function mapServer(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    on: row.is_on,
    wol: {
      mode: row.wol_mode,
      mac: row.wol_mac,
      broadcast: row.wol_broadcast,
      port: row.wol_port,
    },
    manageUrl: row.manage_url,
    pve: row.pve_enabled
      ? {
          host: row.pve_host,
          node: row.pve_node,
          tokenId: row.pve_token_id,
          guests: state.guests.filter((g) => g.server_id === row.id),
        }
      : null,
  };
}

function mapService(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host_label,
    url: row.health_url,
    expect: row.expect_status,
    manageUrl: row.manage_url,
    slack: row.slack_on_fail,
    ok: row.last_ok,
    code: row.last_code,
    ms: row.last_ms,
    checkedAt: row.last_checked_at,
  };
}

function serviceMatches(service) {
  if (state.svcFilter === "down" && service.ok !== false) return false;
  if (state.svcFilter === "unknown" && service.ok != null) return false;
  const q = state.svcQuery.trim().toLowerCase();
  if (!q) return true;
  return [service.name, service.host, service.url].some((v) => (v || "").toLowerCase().includes(q));
}

async function confirmAndRun(message, fn) {
  if (!window.confirm(message)) return;
  try {
    await fn();
  } catch (err) {
    showToast(err.message || "요청에 실패했습니다.");
  }
}

async function loadHouseData() {
  const userId = state.session.user.id;
  await state.sb.rpc("claim_house_invites");
  const { data: membership, error } = await state.sb
    .from("house_members")
    .select("house_id, email, role, houses(*)")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!membership) {
    state.house = null;
    state.membershipRole = null;
    state.members = [];
    state.servers = [];
    state.services = [];
    state.guests = [];
    state.speeds = [];
    return;
  }
  state.house = membership.houses;
  state.membershipRole = membership.role || "member";
  const houseId = state.house.id;

  const [members, servers, services, guests, speeds] = await Promise.all([
    state.sb.from("house_members").select("*").eq("house_id", houseId),
    state.sb.from("servers").select("*").eq("house_id", houseId).order("created_at"),
    state.sb.from("services").select("*").eq("house_id", houseId).order("created_at"),
    state.sb.from("pve_guests").select("*").eq("house_id", houseId),
    state.sb.from("speed_samples").select("*").eq("house_id", houseId).order("recorded_at", { ascending: false }).limit(12),
  ]);

  state.members = members.data || [];
  state.guests = guests.data || [];
  state.servers = (servers.data || []).map(mapServer);
  state.services = (services.data || []).map(mapService);
  state.speeds = (speeds.data || []).reverse();
}

function bars(target, values, threshold) {
  target.replaceChildren();
  if (!values.length) {
    const empty = document.createElement("div");
    empty.className = "sub";
    empty.textContent = "측정 기록 없음";
    empty.style.marginTop = "18px";
    target.appendChild(empty);
    return;
  }
  const max = Math.max(...values, threshold || 1, 1);
  values.forEach((value) => {
    const bar = document.createElement("div");
    bar.className = "bar" + (value < threshold ? " low" : "");
    bar.style.height = Math.max(8, Math.min(100, (value / max) * 100)) + "%";
    bar.title = value + " Mbps";
    target.appendChild(bar);
  });
}

function serverRow(server, index, withDelete) {
  const row = document.createElement("article");
  row.className = "server";
  row.innerHTML = `
    <div class="server-top">
      <div>
        <div class="idx">${String(index + 1).padStart(2, "0")}</div>
        <div class="name"></div>
        <div class="role"></div>
      </div>
      <span class="badge ${server.on ? "on" : "off"}">${server.on ? "켜짐" : "꺼짐"}</span>
    </div>
    <div class="meta"></div>
    <div class="actions"></div>
  `;
  row.querySelector(".name").textContent = server.name;
  row.querySelector(".role").textContent = server.role || "역할 없음";
  row.querySelector(".meta").textContent = wolLabel(server);
  const actions = row.querySelector(".actions");
  if (canWake(server)) {
    const wake = document.createElement("button");
    wake.className = "text-btn live";
    wake.type = "button";
    wake.textContent = "깨우기";
    wake.addEventListener("click", () => enqueueJob("wake", { serverId: server.id }));
    actions.appendChild(wake);
  }
  const manage = document.createElement("button");
  manage.className = "text-btn";
  manage.type = "button";
  manage.textContent = "관리 페이지";
  manage.disabled = !server.manageUrl && !(server.pve && server.pve.host);
  manage.addEventListener("click", () => openManage(server.manageUrl || server.pve?.host || ""));
  actions.appendChild(manage);
  if (withDelete) {
    const remove = document.createElement("button");
    remove.className = "text-btn";
    remove.type = "button";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => confirmAndRun(`${server.name} 서버를 삭제할까요?`, async () => {
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      showToast(`${server.name} 을 목록에서 뺐습니다.`);
      await refresh();
    }));
    actions.appendChild(remove);
  }
  return row;
}

function serviceCard(service, withDelete) {
  const unknown = service.ok == null;
  const card = document.createElement("article");
  card.className = "svc" + (service.ok === false ? " down" : "");
  card.innerHTML = `
    <div class="card-top">
      <div>
        <div class="name"></div>
        <div class="role"></div>
      </div>
      <span class="badge ${service.ok ? "on" : service.ok === false ? "off" : ""}"></span>
    </div>
    <div class="meta url"></div>
    <div class="meta result"></div>
    <div class="actions"></div>
  `;
  card.querySelector(".name").textContent = service.name;
  card.querySelector(".role").textContent = service.host || "호스트 없음";
  card.querySelector(".badge").textContent = unknown ? "미확인" : service.ok ? "정상" : "실패";
  card.querySelector(".url").textContent = service.url;
  card.querySelector(".result").textContent = unknown
    ? `아직 확인 전 · 기대 ${service.expect}`
    : service.ok
      ? `${service.code} · ${service.ms} ms · 기대 ${service.expect}`
      : `${service.code ? `${service.code} 응답` : "응답 없음"} · 기대 ${service.expect}`;
  if (service.checkedAt) {
    const checked = document.createElement("div");
    checked.className = "meta checked";
    checked.textContent = `마지막 확인 ${relativeTime(service.checkedAt)}`;
    checked.title = new Date(service.checkedAt).toLocaleString("ko-KR");
    card.querySelector(".result").after(checked);
  }
  if (!service.slack) {
    const muted = document.createElement("div");
    muted.className = "meta";
    muted.textContent = "Slack 알림 꺼짐";
    card.querySelector(".result").after(muted);
  }
  const actions = card.querySelector(".actions");
  const check = document.createElement("button");
  check.className = "text-btn";
  check.type = "button";
  check.textContent = "다시 확인";
  check.addEventListener("click", () => enqueueJob("health_one", { serviceId: service.id }));
  actions.appendChild(check);
  if (service.manageUrl) {
    const manage = document.createElement("button");
    manage.className = "text-btn";
    manage.type = "button";
    manage.textContent = "관리 페이지";
    manage.addEventListener("click", () => openManage(service.manageUrl));
    actions.appendChild(manage);
  }
  if (withDelete) {
    const edit = document.createElement("button");
    edit.className = "text-btn";
    edit.type = "button";
    edit.textContent = "편집";
    edit.addEventListener("click", () => openServiceModal(service));
    actions.appendChild(edit);
    const remove = document.createElement("button");
    remove.className = "text-btn";
    remove.type = "button";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => confirmAndRun(`${service.name} 헬스 체크를 삭제할까요?`, async () => {
      await api(`/api/services/${service.id}`, { method: "DELETE" });
      showToast(`${service.name} 헬스 체크를 뺐습니다.`);
      await refresh();
    }));
    actions.appendChild(remove);
  }
  return card;
}

function renderList(target, items, factory, emptyText) {
  target.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    target.appendChild(empty);
    return;
  }
  items.forEach((item, index) => target.appendChild(factory(item, index)));
}

function renderPve() {
  const host = $("dash-pve");
  host.replaceChildren();
  const linked = state.servers.filter((s) => s.pve);
  if (!linked.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "연동된 Proxmox가 없습니다. 서버 추가에서 API 주소와 토큰만 넣으면 노드·게스트를 긁어옵니다.";
    host.appendChild(empty);
    return;
  }
  linked.forEach((server) => {
    const card = document.createElement("article");
    card.className = "pve-card";
    const guests = server.pve.guests || [];
    const running = guests.filter((g) => g.is_on).length;
    const nodeNames = [...new Set(guests.map((g) => g.node).filter(Boolean))];
    const title = document.createElement("div");
    title.className = "section-head";
    title.innerHTML = "<h2></h2>";
    title.querySelector("h2").textContent = server.name;
    const go = document.createElement("button");
    go.className = "text-btn";
    go.type = "button";
    go.textContent = "콘솔로 이동";
    go.addEventListener("click", () => openManage(server.manageUrl || server.pve.host));
    title.appendChild(go);
    card.appendChild(title);
    const meta = document.createElement("p");
    meta.className = "sub";
    if (!guests.length) {
      meta.textContent = "에이전트가 아직 동기화하지 않았습니다. 잠시 기다리거나 상태 다시 읽기를 눌러 주세요.";
    } else {
      const nodeLabel = server.pve.node
        ? `노드 ${server.pve.node}`
        : nodeNames.length
          ? `노드 ${nodeNames.length}개 (${nodeNames.join(", ")})`
          : "노드 목록";
      meta.textContent = `${nodeLabel} · 게스트 ${running}개 실행 · ${guests.length - running}개 중지`;
    }
    card.appendChild(meta);
    if (guests.length) {
      const byNode = new Map();
      guests.forEach((guest) => {
        const key = guest.node || server.pve.node || "node";
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push(guest);
      });
      byNode.forEach((list, nodeName) => {
        if (byNode.size > 1 || !server.pve.node) {
          const label = document.createElement("div");
          label.className = "label";
          label.style.marginTop = "12px";
          label.textContent = nodeName;
          card.appendChild(label);
        }
        const grid = document.createElement("div");
        grid.className = "guests";
        list.forEach((guest) => {
          const cell = document.createElement("div");
          cell.className = "guest";
          const svc = state.services.find((service) => service.host === guest.name);
          cell.innerHTML = `<div class="guest-top"><b></b><span class="badge"></span></div><span class="meta kind"></span><span class="meta health"></span>`;
          cell.querySelector("b").textContent = guest.name;
          const badge = cell.querySelector(".badge");
          badge.textContent = guest.is_on ? "실행" : "중지";
          badge.classList.add(guest.is_on ? "on" : "off");
          cell.querySelector(".kind").textContent = guest.kind;
          const health = cell.querySelector(".health");
          if (!svc) health.textContent = "헬스 체크 없음";
          else if (svc.ok == null) health.textContent = "헬스 미확인";
          else if (svc.ok) health.textContent = `헬스 ${svc.code} · ${svc.ms} ms`;
          else {
            health.textContent = "헬스 실패";
            cell.classList.add("down");
          }
          grid.appendChild(cell);
        });
        card.appendChild(grid);
      });
    }
    host.appendChild(card);
  });
}

function healthSummary() {
  const down = state.services.filter((s) => s.ok === false);
  if (!down.length) return "";
  const channel = state.house?.slack_channel || "#homelab";
  return `${down.map((s) => s.name).join(", ")} 헬스 체크가 기대 응답이 아닙니다. ${channel} 알림 대상입니다.`;
}

function latestSpeed() {
  return state.speeds.length ? state.speeds[state.speeds.length - 1] : null;
}

function agentStatus(house = state.house) {
  return house?.agent_status && typeof house.agent_status === "object" ? house.agent_status : {};
}

function isAgentConnected(house = state.house) {
  return Boolean(house?.agent_last_seen_at) &&
    Date.now() - new Date(house.agent_last_seen_at).getTime() < 5 * 60_000;
}

function formatUptime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 60) return `${Math.floor(n)}초`;
  if (n < 3600) return `${Math.floor(n / 60)}분`;
  if (n < 86400) return `${Math.floor(n / 3600)}시간`;
  return `${Math.floor(n / 86400)}일`;
}

function renderAgents() {
  const host = $("dash-agents");
  if (!host) return;
  host.innerHTML = "";
  const house = state.house;
  if (!house?.agent_token_hash && !house?.agent_last_seen_at) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "아직 등록된 에이전트가 없습니다. 설정에서 토큰을 발급해 pm2로 실행하세요.";
    host.appendChild(empty);
    return;
  }

  const status = agentStatus(house);
  const online = isAgentConnected(house);
  const card = document.createElement("article");
  card.className = "card server";
  card.innerHTML = `
    <div class="server-top">
      <div>
        <h3></h3>
        <p class="sub"></p>
      </div>
      <span class="badge"></span>
    </div>
    <div class="kv"></div>
    <div class="row-actions"></div>
  `;
  const title = status.hostname || house.agent_host_label || "집 에이전트";
  card.querySelector("h3").textContent = title;
  card.querySelector(".sub").textContent = online
    ? `온라인 · v${status.version || "?"} · ${status.pm2 ? "pm2" : "process"}`
    : "오프라인 · 마지막 폴링 이후 응답 없음";
  const badge = card.querySelector(".badge");
  badge.textContent = online ? "온라인" : "오프라인";
  badge.classList.add(online ? "on" : "off");

  const kv = card.querySelector(".kv");
  const rows = [
    ["마지막 응답", house.agent_last_seen_at ? relativeTime(house.agent_last_seen_at) : "—"],
    ["버전", status.version || "—"],
    ["Node", status.node || "—"],
    ["가동", formatUptime(status.uptimeSec)],
    ["pm2", status.pm2 ? (status.pm2Name || "예") : "아니오"],
    ["원격 업데이트", status.remoteUpdate ? "가능" : "꺼짐"],
    ["Worker 배포", status.deployOnUpdate ? "업데이트 시 실행" : "꺼짐"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = "<span></span><b></b>";
    row.querySelector("span").textContent = label;
    row.querySelector("b").textContent = value;
    kv.appendChild(row);
  }

  const actions = card.querySelector(".row-actions");
  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.className = "primary";
  updateBtn.textContent = status.deployOnUpdate ? "업데이트 · 배포" : "원격 업데이트";
  updateBtn.disabled = !online || !status.remoteUpdate;
  updateBtn.addEventListener("click", () => enqueueAgentUpdate());
  actions.appendChild(updateBtn);
  host.appendChild(card);
}

async function enqueueAgentUpdate() {
  if (!state.house) return;
  if (!isAgentConnected()) {
    showToast("에이전트가 오프라인입니다.");
    return;
  }
  if (!agentStatus().remoteUpdate) {
    showToast("에이전트에서 AGENT_ALLOW_REMOTE_UPDATE=true 가 필요합니다.");
    return;
  }
  await enqueueJob("agent_update");
  showToast(
    agentStatus().deployOnUpdate
      ? "업데이트·배포 작업을 넣었습니다. git pull 후 npm run deploy가 실행됩니다."
      : "업데이트 작업을 넣었습니다. 잠시 후 상태가 갱신됩니다.",
  );
}

function render() {
  if (!state.house) return;
  const house = state.house;
  const threshold = Number(house.speed_threshold_mbps) || 100;
  const latest = latestSpeed();
  const down = latest ? Number(latest.down_mbps) : null;
  const up = latest ? Number(latest.up_mbps) : null;
  const dropped = down != null && down < threshold;
  const agentConnected = isAgentConnected(house);
  const status = agentStatus(house);

  $("house-name").textContent = house.name;
  $("dash-title").textContent = house.name;
  $("house-input").value = house.name;
  $("who").textContent = state.session.user.email || "";
  $("public-ip").textContent = house.public_ip || "—";
  $("public-ip-meta").textContent = relativeTime(house.public_ip_checked_at);
  $("agent-seen").textContent = house.agent_last_seen_at ? relativeTime(house.agent_last_seen_at) : "미연결";
  $("agent-version").textContent = status.version || "—";
  $("agent-host").textContent = status.hostname || house.agent_host_label || "—";
  $("agent-status").textContent = agentConnected
    ? (status.hostname || house.agent_host_label || "연결됨")
    : "미연결";
  $("agent-online").textContent = agentConnected ? "온라인" : "오프라인";
  $("agent-seen-settings").textContent = house.agent_last_seen_at ? relativeTime(house.agent_last_seen_at) : "—";
  $("agent-version-settings").textContent = status.version || "—";
  $("agent-host-settings").textContent = status.hostname || house.agent_host_label || "—";
  $("agent-runtime").textContent = status.node
    ? `${status.node} · ${status.platform}/${status.arch} · ${formatUptime(status.uptimeSec)}`
    : "—";
  $("agent-pm2").textContent = status.pm2
    ? (status.pm2Name ? `예 (${status.pm2Name})` : "예")
    : (status.reportedAt ? "아니오" : "—");
  $("agent-remote-update").textContent = status.remoteUpdate ? "가능" : "꺼짐";
  $("agent-deploy-on-update").textContent = status.deployOnUpdate ? "업데이트 시 실행" : "꺼짐";
  $("net-status").textContent = agentConnected ? "에이전트 연결됨" : "에이전트 대기";
  $("net-dot").style.background = agentConnected ? "#12a150" : "#948e84";
  $("dash-down").textContent = down == null ? "—" : down.toFixed(1);
  $("dash-up").textContent = up == null ? "—" : up.toFixed(1);
  $("speed-down").textContent = down == null ? "—" : down.toFixed(1);
  $("speed-up").textContent = up == null ? "—" : up.toFixed(1);
  $("threshold").value = String(threshold);
  $("slack-channel").value = house.slack_channel || "#homelab";
  const mins = (sec, fallback) => {
    const n = Number(sec);
    return String(Number.isFinite(n) ? Math.round(n / 60) : fallback);
  };
  if (document.activeElement !== $("interval-health")) {
    $("interval-health").value = mins(house.health_interval_sec, 5);
  }
  if (document.activeElement !== $("interval-pve")) {
    $("interval-pve").value = mins(house.pve_interval_sec, 15);
  }
  if (document.activeElement !== $("interval-speed")) {
    $("interval-speed").value = mins(house.speed_interval_sec, 60);
  }
  if (document.activeElement !== $("interval-public-ip")) {
    $("interval-public-ip").value = mins(house.public_ip_interval_sec, 120);
  }
  if (document.activeElement !== $("agent-url")) {
    $("agent-url").value = house.agent_url || "";
  }
  if (document.activeElement !== $("agent-host-label")) {
    $("agent-host-label").value = house.agent_host_label || status.hostname || "";
  }
  const updateEnabled = agentConnected && Boolean(status.remoteUpdate);
  ["agent-update", "agent-update-dash"].forEach((id) => {
    const btn = $(id);
    if (btn) btn.disabled = !updateEnabled;
  });
  renderAgents();
  $("dash-threshold").textContent = down == null
    ? `임계값 ${threshold} Mbps · 측정 대기`
    : dropped
      ? `임계값 ${threshold} Mbps · 저하`
      : `임계값 ${threshold} Mbps · 정상`;

  const onCount = state.servers.filter((s) => s.on).length;
  const offCount = state.servers.length - onCount;
  const downCount = state.services.filter((s) => s.ok === false).length;
  const okCount = state.services.filter((s) => s.ok === true).length;
  $("summary-servers").innerHTML = `${onCount}<em>/${state.servers.length}</em> 서버`;
  $("summary-services").textContent = state.services.length
    ? `서비스 ${okCount}/${state.services.length} 정상 · ${agentConnected ? "에이전트 연결됨" : "에이전트 대기"}`
    : `등록된 서비스 없음 · ${agentConnected ? "에이전트 연결됨" : "에이전트 대기"}`;
  $("summary-off").textContent = String(offCount);
  $("summary-down").textContent = String(downCount);

  const history = state.speeds.map((s) => Number(s.down_mbps));
  bars($("dash-bars"), history, threshold);
  bars($("speed-bars"), history, threshold);

  const alertText = dropped
    ? `다운로드 ${down.toFixed(1)} Mbps가 임계값 ${threshold} Mbps보다 낮습니다. ${house.slack_channel} 알림 대상입니다.`
    : "";
  ["dash-alert", "speed-alert"].forEach((id) => {
    const el = $(id);
    el.hidden = !alertText;
    el.textContent = alertText;
  });
  const health = healthSummary();
  ["health-alert", "health-alert-page"].forEach((id) => {
    const el = $(id);
    el.hidden = !health;
    el.textContent = health;
  });

  const visible = state.servers.filter((server) => {
    if (state.filter === "off") return !server.on;
    if (state.filter === "pve") return Boolean(server.pve);
    return true;
  });
  renderList($("dash-servers"), state.servers, (s, i) => serverRow(s, i, false), "등록된 서버가 없습니다. 서버 추가로 집을 채우면 됩니다.");
  renderList($("server-list"), visible, (s, i) => serverRow(s, i, true), "등록된 서버가 없습니다. 서버 추가로 집을 채우면 됩니다.");
  renderList($("dash-services"), state.services.filter((s) => s.ok === false), (s) => serviceCard(s, false), "실패한 헬스 체크가 없습니다.");
  renderList(
    $("service-list"),
    state.services.filter(serviceMatches),
    (s) => serviceCard(s, true),
    state.services.length
      ? "조건에 맞는 서비스가 없습니다."
      : "등록된 서비스가 없습니다. 서비스 추가로 헬스 체크 주소를 등록하면 됩니다.",
  );
  $("svc-count-all").textContent = String(state.services.length);
  $("svc-count-down").textContent = String(downCount);
  $("svc-count-unknown").textContent = String(state.services.filter((s) => s.ok == null).length);
  $("check-all").disabled = !state.services.length;
  renderPve();
  applyOwnerUi();

  const members = $("members");
  members.replaceChildren();
  state.members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member";
    const name = document.createElement("span");
    name.textContent = `${member.email}${member.role === "owner" ? " (owner)" : ""}`;
    row.appendChild(name);
    if (isOwner() && member.user_id !== state.session.user.id) {
      const remove = document.createElement("button");
      remove.className = "text-btn";
      remove.type = "button";
      remove.textContent = "빼기";
      remove.addEventListener("click", () => confirmAndRun(`${member.email} 을 집에서 뺄까요?`, async () => {
        const { error } = await state.sb.from("house_members").delete().eq("house_id", house.id).eq("user_id", member.user_id);
        if (error) throw error;
        await refresh();
      }));
      row.appendChild(remove);
    }
    members.appendChild(row);
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
  });
  ["dashboard", "servers", "services", "speed", "settings"].forEach((view) => {
    $("view-" + view).hidden = state.view !== view;
  });
}

async function refresh() {
  await loadHouseData();
  render();
}

async function enqueueJob(kind, payload = {}, { quiet = false } = {}) {
  if (!state.house) return;
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ houseId: state.house.id, kind, payload }),
    });
  } catch (err) {
    showToast(err.message || "작업을 넣지 못했습니다.");
    return;
  }
  if (!quiet) {
    showToast(isAgentConnected()
      ? "에이전트에 작업을 넣었습니다."
      : "작업을 넣었습니다. 에이전트가 오프라인이라 연결되면 처리됩니다.");
  }
  await refresh();
}

function openManage(url) {
  if (!url) {
    showToast("관리 페이지 주소가 없습니다.");
    return;
  }
  if (!isSafeHttpUrl(url)) {
    showToast("허용되지 않는 관리 페이지 주소입니다.");
    return;
  }
  $("redir-url").textContent = url;
  $("open-redir").href = url;
  $("redirect-modal").hidden = false;
}

function applyOwnerUi() {
  const owner = isOwner();
  ["save-house", "save-speed-settings", "mint-agent-token"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !owner;
  });
  const invite = $("invite-form");
  if (invite) {
    invite.querySelectorAll("input, button").forEach((el) => {
      el.disabled = !owner;
    });
  }
  const hint = $("owner-only-hint");
  if (hint) hint.hidden = owner;
}

function setWol(mode) {
  state.wol = mode === "manual" ? "manual" : "off";
  document.querySelectorAll("#wol-choice button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.wol === state.wol));
  });
  $("wol-manual").hidden = state.wol !== "manual";
  if (state.wol === "manual") $("srv-mac").required = true;
  else $("srv-mac").required = false;
}

function openServerModal() {
  $("server-form").reset();
  $("srv-bcast").value = "";
  $("srv-port").value = "9";
  $("srv-error").textContent = "";
  $("pve-fields").hidden = true;
  $("srv-pve").checked = false;
  $("srv-pve-host").required = false;
  $("srv-pve-token").required = false;
  $("srv-pve-secret").required = false;
  setWol("manual");
  $("server-modal").hidden = false;
  $("srv-name").focus();
}

function fillHostOptions() {
  const names = new Set();
  state.servers.forEach((s) => s.name && names.add(s.name));
  state.guests.forEach((g) => g.name && names.add(g.name));
  state.services.forEach((s) => s.host && names.add(s.host));
  const list = $("svc-host-options");
  list.replaceChildren(...[...names].sort().map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
}

function openServiceModal(service = null) {
  const editing = service && service.id ? service : null;
  state.editingServiceId = editing?.id || null;
  $("svc-form").reset();
  $("svc-title").textContent = editing ? "서비스 편집" : "서비스 추가";
  $("svc-submit").textContent = editing ? "저장" : "추가";
  $("svc-check-now-row").hidden = Boolean(editing);
  $("svc-name").value = editing?.name || "";
  $("svc-host").value = editing?.host || "";
  $("svc-url").value = editing?.url || "";
  $("svc-expect").value = String(editing?.expect || 200);
  $("svc-manage").value = editing?.manageUrl || "";
  $("svc-slack").checked = editing ? Boolean(editing.slack) : true;
  $("svc-check-now").checked = true;
  $("svc-error").textContent = "";
  fillHostOptions();
  $("svc-modal").hidden = false;
  $("svc-name").focus();
}

function closeServiceModal() {
  $("svc-modal").hidden = true;
  state.editingServiceId = null;
}

async function ensureHouse(houseName) {
  await api("/api/bootstrap", {
    method: "POST",
    body: JSON.stringify({ houseName }),
  });
}

async function enterApp() {
  $("auth").hidden = true;
  $("app").hidden = false;
  await loadHouseData();
  if (!state.house) {
    const name = window.prompt("아직 집이 없습니다. 집 이름을 입력해 주세요.", "우리집");
    if (!name?.trim()) {
      await state.sb.auth.signOut();
      return;
    }
    await ensureHouse(name.trim());
    await loadHouseData();
  }
  render();
}

async function init() {
  state.config = await api("/api/config");
  $("slack-status").textContent = state.config.slackConfigured
    ? "웹훅이 Worker에 설정되어 있습니다."
    : "웹훅이 아직 없습니다. wrangler secret put SLACK_WEBHOOK_URL";
  if (state.config.agentServiceRoleConfigured === false) {
    showToast("Worker에 SUPABASE_SERVICE_ROLE_KEY가 없습니다. 에이전트 poll이 거부됩니다.");
  }

  if (state.config.inviteOnly && !state.config.inviteHookReady) {
    $("login-hint").textContent =
      "회원가입은 없습니다. Supabase에서 사용자를 만든 뒤 로그인하세요. ⚠ Auth Hook(Before User Created → hook_invite_only_signup)이 연결되지 않았을 수 있습니다.";
  }

  state.sb = createClient(state.config.supabaseUrl, state.config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const { data: { session } } = await state.sb.auth.getSession();
  if (session) {
    state.session = session;
    await enterApp();
  }

  state.sb.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    if (session && $("app").hidden) await enterApp();
    if (!session) {
      $("app").hidden = true;
      $("auth").hidden = false;
    }
  });

  $("panel-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-error").textContent = "";
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    const { data, error } = await state.sb.auth.signInWithPassword({ email, password });
    if (error) {
      $("login-error").textContent = error.message;
      return;
    }
    state.session = data.session;
    await enterApp();
  });

  $("logout").addEventListener("click", async () => {
    await state.sb.auth.signOut();
    Object.assign(state, {
      session: null,
      house: null,
      membershipRole: null,
      members: [],
      servers: [],
      services: [],
      guests: [],
      speeds: [],
      view: "dashboard",
    });
    $("app").hidden = true;
    $("auth").hidden = false;
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => {
        item.setAttribute("aria-selected", String(item === button));
      });
      render();
    });
  });

  $("add-from-dash").addEventListener("click", openServerModal);
  $("add-from-list").addEventListener("click", openServerModal);
  $("close-server").addEventListener("click", () => { $("server-modal").hidden = true; });
  $("close-redir").addEventListener("click", () => { $("redirect-modal").hidden = true; });
  $("add-svc-list").addEventListener("click", () => openServiceModal());
  $("add-svc-dash").addEventListener("click", () => openServiceModal());
  $("close-svc").addEventListener("click", closeServiceModal);
  document.querySelectorAll("[data-svc-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.svcFilter = button.dataset.svcFilter;
      document.querySelectorAll("[data-svc-filter]").forEach((item) => {
        item.setAttribute("aria-selected", String(item === button));
      });
      render();
    });
  });
  $("svc-search").addEventListener("input", (event) => {
    state.svcQuery = event.target.value;
    render();
  });
  document.querySelectorAll(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      overlay.hidden = true;
      if (overlay.id === "svc-modal") state.editingServiceId = null;
    });
  });
  $("goto-services").addEventListener("click", () => { state.view = "services"; render(); });

  document.querySelectorAll("#wol-choice button").forEach((button) => {
    button.addEventListener("click", () => setWol(button.dataset.wol));
  });
  $("srv-pve").addEventListener("change", () => {
    const on = $("srv-pve").checked;
    $("pve-fields").hidden = !on;
    $("srv-pve-host").required = on;
    $("srv-pve-token").required = on;
    $("srv-pve-secret").required = on;
  });

  $("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("srv-error").textContent = "";
    try {
      const data = await api("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          houseId: state.house.id,
          name: $("srv-name").value.trim(),
          role: $("srv-role").value.trim(),
          manageUrl: $("srv-url").value.trim(),
          wolMode: state.wol,
          wolMac: $("srv-mac").value.trim(),
          wolBroadcast: $("srv-bcast").value.trim(),
          wolPort: Number($("srv-port").value) || 9,
          pveEnabled: $("srv-pve").checked,
          pveHost: $("srv-pve-host").value.trim(),
          pveNode: $("srv-pve-node").value.trim(),
          pveTokenId: $("srv-pve-token").value.trim(),
          pveTokenSecret: $("srv-pve-secret").value,
        }),
      });
      $("server-modal").hidden = true;
      $("srv-pve-secret").value = "";
      showToast(
        data.syncQueued
          ? "서버를 추가했습니다. Proxmox 노드·게스트를 곧 긁어옵니다."
          : "서버를 추가했습니다.",
      );
      await refresh();
    } catch (err) {
      $("srv-error").textContent = err.message;
    }
  });

  $("svc-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("svc-error").textContent = "";
    const submit = $("svc-submit");
    const editingId = state.editingServiceId;
    const fields = {
      name: $("svc-name").value.trim(),
      hostLabel: $("svc-host").value.trim(),
      healthUrl: $("svc-url").value.trim(),
      expectStatus: Number($("svc-expect").value || 200),
      manageUrl: $("svc-manage").value.trim(),
      slackOnFail: $("svc-slack").checked,
    };
    submit.disabled = true;
    try {
      const data = editingId
        ? await api(`/api/services/${editingId}`, { method: "PATCH", body: JSON.stringify(fields) })
        : await api("/api/services", {
            method: "POST",
            body: JSON.stringify({ houseId: state.house.id, checkNow: $("svc-check-now").checked, ...fields }),
          });
      closeServiceModal();
      const verb = editingId ? "저장했습니다" : "추가했습니다";
      const followUp = data.checkQueued
        ? isAgentConnected()
          ? " 곧 첫 확인 결과가 표시됩니다."
          : " 에이전트가 연결되면 확인합니다."
        : "";
      showToast(`${fields.name} 헬스 체크를 ${verb}.${followUp}`);
      state.view = "services";
      await refresh();
    } catch (err) {
      $("svc-error").textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  $("refresh").addEventListener("click", async () => {
    await enqueueJob("health_all");
    await enqueueJob("pve_sync");
  });
  $("check-all").addEventListener("click", () => enqueueJob("health_all"));
  $("probe-speed").addEventListener("click", () => enqueueJob("speed_probe"));

  $("save-speed-settings").addEventListener("click", async () => {
    if (!isOwner()) {
      showToast("owner만 설정을 바꿀 수 있습니다.");
      return;
    }
    const threshold = Number($("threshold").value);
    const channel = $("slack-channel").value.trim() || "#homelab";
    const toSec = (id, fallbackMin) => {
      const raw = Number($(id).value);
      const mins = Number.isFinite(raw) ? Math.max(0, Math.min(10080, Math.floor(raw))) : fallbackMin;
      $(id).value = String(mins);
      return mins * 60;
    };
    const { error } = await state.sb.from("houses").update({
      speed_threshold_mbps: threshold,
      slack_channel: channel,
      health_interval_sec: toSec("interval-health", 5),
      pve_interval_sec: toSec("interval-pve", 15),
      speed_interval_sec: toSec("interval-speed", 60),
      public_ip_interval_sec: toSec("interval-public-ip", 120),
      updated_at: new Date().toISOString(),
    }).eq("id", state.house.id);
    if (error) {
      showToast(error.message);
      return;
    }
    showToast("임계값·자동 확인 주기를 저장했습니다.");
    await refresh();
  });

  $("save-house").addEventListener("click", async () => {
    if (!isOwner()) {
      showToast("owner만 집 이름을 바꿀 수 있습니다.");
      return;
    }
    const name = $("house-input").value.trim() || "이름 없는 집";
    const { error } = await state.sb.from("houses").update({ name, updated_at: new Date().toISOString() }).eq("id", state.house.id);
    if (error) {
      showToast(error.message);
      return;
    }
    showToast("집 이름을 저장했습니다.");
    await refresh();
  });

  $("invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const email = $("invite-email").value.trim();
      await api("/api/invite", {
        method: "POST",
        body: JSON.stringify({ houseId: state.house.id, email }),
      });
      $("invite-email").value = "";
      showToast(`${email} 을 허용 목록에 넣었습니다. Supabase에서 사용자를 만든 뒤 로그인하면 합류합니다.`);
      await refresh();
    } catch (err) {
      showToast(err.message);
    }
  });

  $("mint-agent-token").addEventListener("click", async () => {
    const data = await api("/api/agent/token", {
      method: "POST",
      body: JSON.stringify({
        houseId: state.house.id,
        agentUrl: $("agent-url").value.trim(),
        agentHostLabel: $("agent-host-label").value.trim(),
      }),
    });
    $("agent-token-box").hidden = false;
    $("agent-token-box").textContent = data.token;
    $("agent-token-hint").textContent = "이 토큰을 복사해 에이전트 AGENT_TOKEN에 넣으세요. 다시 볼 수 없습니다.";
    showToast("에이전트 토큰을 발급했습니다.");
    await refresh();
  });

  $("agent-refresh")?.addEventListener("click", () => refresh());
  $("agent-update")?.addEventListener("click", () => enqueueAgentUpdate());
  $("agent-update-dash")?.addEventListener("click", () => enqueueAgentUpdate());

  // Keep agent/online status fresh while the console is open.
  clearInterval(init._agentTimer);
  init._agentTimer = setInterval(() => {
    if (!state.session || !state.house) return;
    refresh().catch(() => {});
  }, 30_000);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("server-modal").hidden = true;
      closeServiceModal();
      $("redirect-modal").hidden = true;
    }
  });
}

init().catch((err) => {
  console.error(err);
  $("login-error").textContent = err.message || "초기화 실패";
});
