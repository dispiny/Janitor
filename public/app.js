import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";

const $ = (id) => document.getElementById(id);

const state = {
  view: "dashboard",
  filter: "all",
  wol: "uplus",
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

function wolLabel(server) {
  if (server.wol_mode === "uplus") return "U+ 공유기";
  if (server.wol_mode === "manual") return "수동 MAC";
  return "WOL 없음";
}

function mapServer(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    on: row.is_on,
    wol: {
      mode: row.wol_mode,
      device: row.wol_uplus_device,
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
  };
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
  if (server.wol.mode !== "off") {
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
    remove.addEventListener("click", async () => {
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      showToast(`${server.name} 을 목록에서 뺐습니다.`);
      await refresh();
    });
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
      : `응답 없음/실패 · 기대 ${service.expect}`;
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
    const remove = document.createElement("button");
    remove.className = "text-btn";
    remove.type = "button";
    remove.textContent = "삭제";
    remove.addEventListener("click", async () => {
      await api(`/api/services/${service.id}`, { method: "DELETE" });
      showToast(`${service.name} 헬스 체크를 뺐습니다.`);
      await refresh();
    });
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
  const nodes = state.servers.filter((s) => s.pve);
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "연동된 Proxmox 노드가 없습니다. 서버 추가에서 노드로 연결할 수 있습니다.";
    host.appendChild(empty);
    return;
  }
  nodes.forEach((server) => {
    const card = document.createElement("article");
    card.className = "pve-card";
    const guests = server.pve.guests || [];
    const running = guests.filter((g) => g.is_on).length;
    const title = document.createElement("div");
    title.className = "section-head";
    title.innerHTML = "<h2></h2>";
    title.querySelector("h2").textContent = server.pve.node;
    const go = document.createElement("button");
    go.className = "text-btn";
    go.type = "button";
    go.textContent = "노드 콘솔로 이동";
    go.addEventListener("click", () => openManage(server.manageUrl || server.pve.host));
    title.appendChild(go);
    card.appendChild(title);
    const meta = document.createElement("p");
    meta.className = "sub";
    meta.textContent = guests.length
      ? `게스트 ${running}개 실행 · ${guests.length - running}개 중지 · 토큰 ${server.pve.tokenId || "—"}`
      : "에이전트가 게스트 목록을 아직 동기화하지 않았습니다.";
    card.appendChild(meta);
    if (guests.length) {
      const grid = document.createElement("div");
      grid.className = "guests";
      guests.forEach((guest) => {
        const cell = document.createElement("div");
        cell.className = "guest";
        const linked = state.services.find((service) => service.host === guest.name);
        cell.innerHTML = `<div class="guest-top"><b></b><span class="badge"></span></div><span class="meta kind"></span><span class="meta health"></span>`;
        cell.querySelector("b").textContent = guest.name;
        const badge = cell.querySelector(".badge");
        badge.textContent = guest.is_on ? "실행" : "중지";
        badge.classList.add(guest.is_on ? "on" : "off");
        cell.querySelector(".kind").textContent = guest.kind;
        const health = cell.querySelector(".health");
        if (!linked) health.textContent = "헬스 체크 없음";
        else if (linked.ok == null) health.textContent = "헬스 미확인";
        else if (linked.ok) health.textContent = `헬스 ${linked.code} · ${linked.ms} ms`;
        else {
          health.textContent = "헬스 실패";
          cell.classList.add("down");
        }
        grid.appendChild(cell);
      });
      card.appendChild(grid);
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

function render() {
  if (!state.house) return;
  const house = state.house;
  const threshold = Number(house.speed_threshold_mbps) || 100;
  const latest = latestSpeed();
  const down = latest ? Number(latest.down_mbps) : null;
  const up = latest ? Number(latest.up_mbps) : null;
  const dropped = down != null && down < threshold;
  const agentConnected = Boolean(house.agent_last_seen_at) &&
    Date.now() - new Date(house.agent_last_seen_at).getTime() < 5 * 60_000;

  $("house-name").textContent = house.name;
  $("dash-title").textContent = house.name;
  $("house-input").value = house.name;
  $("who").textContent = state.session.user.email || "";
  $("public-ip").textContent = house.public_ip || "—";
  $("public-ip-meta").textContent = relativeTime(house.public_ip_checked_at);
  $("agent-seen").textContent = house.agent_last_seen_at ? relativeTime(house.agent_last_seen_at) : "미연결";
  $("agent-status").textContent = house.agent_host_label || (agentConnected ? "연결됨" : "미연결");
  $("net-status").textContent = agentConnected ? "에이전트 연결됨" : "에이전트 대기";
  $("net-dot").style.background = agentConnected ? "#12a150" : "#948e84";
  $("dash-down").textContent = down == null ? "—" : down.toFixed(1);
  $("dash-up").textContent = up == null ? "—" : up.toFixed(1);
  $("speed-down").textContent = down == null ? "—" : down.toFixed(1);
  $("speed-up").textContent = up == null ? "—" : up.toFixed(1);
  $("threshold").value = String(threshold);
  $("slack-channel").value = house.slack_channel || "#homelab";
  $("agent-url").value = house.agent_url || "";
  $("agent-host-label").value = house.agent_host_label || "";
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
  renderList($("service-list"), state.services, (s) => serviceCard(s, true), "등록된 서비스가 없습니다. 헬스 체크 주소를 추가하면 됩니다.");
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
      remove.addEventListener("click", async () => {
        await state.sb.from("house_members").delete().eq("house_id", house.id).eq("user_id", member.user_id);
        await refresh();
      });
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

async function enqueueJob(kind, payload = {}) {
  if (!state.house) return;
  await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ houseId: state.house.id, kind, payload }),
  });
  showToast("에이전트에 작업을 넣었습니다.");
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
  state.wol = mode;
  document.querySelectorAll("#wol-choice button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.wol === mode));
  });
  $("wol-uplus").hidden = mode !== "uplus";
  $("wol-manual").hidden = mode !== "manual";
}

function openServerModal() {
  $("server-form").reset();
  $("srv-bcast").value = "192.168.0.255";
  $("srv-port").value = "9";
  $("srv-error").textContent = "";
  $("pve-fields").hidden = true;
  setWol("uplus");
  $("server-modal").hidden = false;
  $("srv-name").focus();
}

function openServiceModal() {
  $("svc-form").reset();
  $("svc-expect").value = "200";
  $("svc-slack").checked = true;
  $("svc-error").textContent = "";
  $("svc-modal").hidden = false;
  $("svc-name").focus();
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

  const bootstrap = Boolean(state.config.bootstrapAllowed);
  const hookReady = Boolean(state.config.inviteHookReady);
  const signupBlocked = state.config.inviteOnly && !hookReady && !bootstrap;
  $("signup-house-field").hidden = !bootstrap;
  $("signup-house").required = bootstrap;
  let signupHint = bootstrap
    ? "아직 계정이 없어 첫 집 주인을 만들 수 있습니다. 이후에는 초대받은 이메일만 가입됩니다."
    : "설정에서 초대한 이메일만 가입됩니다. 아무나 계정을 만들 수 없습니다.";
  if (state.config.inviteOnly && !hookReady) {
    signupHint +=
      " ⚠ Supabase Auth Hook(Before User Created → hook_invite_only_signup)이 연결되지 않아 초대 가입을 막았습니다. 대시보드에서 활성화하세요.";
  }
  $("signup-hint").textContent = signupHint;
  $("tab-signup").disabled = signupBlocked;
  $("panel-signup").querySelectorAll("input, button").forEach((el) => {
    el.disabled = signupBlocked;
  });

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

  $("tab-login").addEventListener("click", () => {
    $("tab-login").setAttribute("aria-selected", "true");
    $("tab-signup").setAttribute("aria-selected", "false");
    $("panel-login").hidden = false;
    $("panel-signup").hidden = true;
    $("auth-title").textContent = "로그인";
  });
  $("tab-signup").addEventListener("click", () => {
    $("tab-signup").setAttribute("aria-selected", "true");
    $("tab-login").setAttribute("aria-selected", "false");
    $("panel-signup").hidden = false;
    $("panel-login").hidden = true;
    $("auth-title").textContent = "초대 가입";
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

  $("panel-signup").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("signup-error").textContent = "";
    const email = $("signup-email").value.trim();
    const password = $("signup-password").value;
    const bootstrap = Boolean(state.config?.bootstrapAllowed);
    const houseName = $("signup-house").value.trim();
    if (bootstrap && !houseName) {
      $("signup-error").textContent = "첫 계정은 집 이름이 필요합니다.";
      return;
    }
    const { data, error } = await state.sb.auth.signUp({ email, password });
    if (error) {
      $("signup-error").textContent = error.message.includes("초대")
        ? error.message
        : (error.message || "가입이 거부되었습니다. 초대받은 이메일인지 확인하세요.");
      return;
    }
    if (!data.session) {
      $("signup-error").textContent = "이메일 확인이 필요합니다. 받은편지함을 확인한 뒤 로그인해 주세요.";
      return;
    }
    state.session = data.session;
    if (bootstrap) {
      await api("/api/bootstrap", {
        method: "POST",
        body: JSON.stringify({ houseName }),
      });
      await enterApp();
      showToast(`${houseName} 을 만들었습니다. 이후 가입은 초대만 가능합니다.`);
      return;
    }
    await enterApp();
    showToast("가입했습니다. 초대된 집으로 합류합니다.");
  });

  $("logout").addEventListener("click", async () => {
    await state.sb.auth.signOut();
    state.house = null;
    state.servers = [];
    state.services = [];
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
  $("add-svc-list").addEventListener("click", openServiceModal);
  $("close-svc").addEventListener("click", () => { $("svc-modal").hidden = true; });
  $("goto-services").addEventListener("click", () => { state.view = "services"; render(); });

  document.querySelectorAll("#wol-choice button").forEach((button) => {
    button.addEventListener("click", () => setWol(button.dataset.wol));
  });
  $("srv-pve").addEventListener("change", () => {
    $("pve-fields").hidden = !$("srv-pve").checked;
  });

  $("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("srv-error").textContent = "";
    try {
      await api("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          houseId: state.house.id,
          name: $("srv-name").value.trim(),
          role: $("srv-role").value.trim(),
          manageUrl: $("srv-url").value.trim(),
          wolMode: state.wol,
          wolUplusDevice: $("srv-uplus").value.trim(),
          wolMac: $("srv-mac").value.trim(),
          wolBroadcast: $("srv-bcast").value.trim(),
          wolPort: Number($("srv-port").value),
          pveEnabled: $("srv-pve").checked,
          pveHost: $("srv-pve-host").value.trim(),
          pveNode: $("srv-pve-node").value.trim(),
          pveTokenId: $("srv-pve-token").value.trim(),
          pveTokenSecret: $("srv-pve-secret").value,
        }),
      });
      $("server-modal").hidden = true;
      $("srv-pve-secret").value = "";
      showToast("서버를 추가했습니다.");
      await refresh();
    } catch (err) {
      $("srv-error").textContent = err.message;
    }
  });

  $("svc-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("svc-error").textContent = "";
    try {
      await api("/api/services", {
        method: "POST",
        body: JSON.stringify({
          houseId: state.house.id,
          name: $("svc-name").value.trim(),
          hostLabel: $("svc-host").value.trim(),
          healthUrl: $("svc-url").value.trim(),
          expectStatus: Number($("svc-expect").value),
          manageUrl: $("svc-manage").value.trim(),
          slackOnFail: $("svc-slack").checked,
        }),
      });
      $("svc-modal").hidden = true;
      showToast("헬스 체크를 추가했습니다.");
      state.view = "services";
      await refresh();
    } catch (err) {
      $("svc-error").textContent = err.message;
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
    const { error } = await state.sb.from("houses").update({
      speed_threshold_mbps: threshold,
      slack_channel: channel,
      updated_at: new Date().toISOString(),
    }).eq("id", state.house.id);
    if (error) {
      showToast(error.message);
      return;
    }
    showToast("속도 알림 설정을 저장했습니다.");
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
      showToast(`${email} 초대를 저장했습니다. 상대방이 같은 이메일로 로그인하면 합류합니다.`);
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("server-modal").hidden = true;
      $("svc-modal").hidden = true;
      $("redirect-modal").hidden = true;
    }
  });
}

init().catch((err) => {
  console.error(err);
  $("login-error").textContent = err.message || "초기화 실패";
});
