import type { Env } from "./env";
import { dedupeAlerts } from "./alert-dedupe";
import { buildOpsAlert, notifySlack } from "./slack";
import { anonClient, serviceClient, sha256Hex, userClient } from "./supabase";
import { isUuid, parseServiceInput, type ServiceInput } from "./services";
import { assertHttpUrl } from "./urls";
import { parseWol } from "./wol";
import type { SupabaseClient } from "@supabase/supabase-js";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || null;
}

async function requireUser(env: Env, req: Request) {
  const token = bearer(req);
  if (!token) return { error: json({ error: "unauthorized" }, 401) };
  const sb = userClient(env, token);
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return { error: json({ error: "unauthorized" }, 401) };
  return { sb, user: data.user, token };
}

async function requireHouseOwner(
  sb: SupabaseClient,
  houseId: string,
): Promise<Response | null> {
  const { data, error } = await sb.rpc("is_house_owner", { target_house: houseId });
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "owner만 할 수 있습니다." }, 403);
  return null;
}

const JOB_KINDS = new Set(["wake", "health_all", "health_one", "pve_sync", "speed_probe", "agent_update"]);

/** Prefer service role (SEC-10); fall back to anon until revoke migration is applied. */
function agentDb(env: Env): SupabaseClient {
  return serviceClient(env) ?? anonClient(env);
}

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  try {
    if (req.method === "GET" && path === "/api/config") {
      const sb = anonClient(env);
      const { data: signup } = await sb.rpc("signup_status");
      const status = (signup || {}) as {
        inviteOnly?: boolean;
        bootstrapAllowed?: boolean;
        hookReady?: boolean;
        adminProvisionedOnly?: boolean;
        signupEnabled?: boolean;
      };
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        slackConfigured: Boolean(env.SLACK_WEBHOOK_URL),
        inviteOnly: status.inviteOnly !== false,
        bootstrapAllowed: Boolean(status.bootstrapAllowed),
        inviteHookReady: Boolean(status.hookReady),
        adminProvisionedOnly: status.adminProvisionedOnly !== false,
        signupEnabled: Boolean(status.signupEnabled),
      });
    }

    if (path === "/api/bootstrap" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as { houseName?: string };
      const houseName = (body.houseName || "").trim();
      if (!houseName) return json({ error: "집 이름이 필요합니다." }, 400);

      await auth.sb!.rpc("claim_house_invites");

      const { data: existing } = await auth.sb!
        .from("house_members")
        .select("house_id")
        .eq("user_id", auth.user!.id)
        .limit(1)
        .maybeSingle();

      if (existing?.house_id) {
        return json({ houseId: existing.house_id, created: false });
      }

      const { data: houseId, error } = await auth.sb!.rpc("create_house", { p_name: houseName });
      if (error || !houseId) return json({ error: error?.message || "집을 만들지 못했습니다." }, 400);
      return json({ houseId, created: true });
    }

    if (path === "/api/servers" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as {
        houseId: string;
        name: string;
        role?: string;
        manageUrl?: string;
        wolMode: "off" | "manual";
        wolMac?: string;
        wolBroadcast?: string;
        wolPort?: number;
        pveEnabled?: boolean;
        pveHost?: string;
        pveNode?: string;
        pveTokenId?: string;
        pveTokenSecret?: string;
      };

      if (!body.houseId || !body.name?.trim()) return json({ error: "이름과 집이 필요합니다." }, 400);
      const wolMode = body.wolMode === "manual" ? "manual" : "off";
      if (body.wolMode && body.wolMode !== "manual" && body.wolMode !== "off") {
        return json({ error: "Wake-on-LAN은 MAC 등록 방식만 지원합니다." }, 400);
      }
      const wol = wolMode === "manual"
        ? parseWol({ mac: body.wolMac, broadcast: body.wolBroadcast, port: body.wolPort })
        : null;
      if (wol && !wol.ok) return json({ error: wol.error }, 400);
      if (body.pveEnabled) {
        if (!body.pveHost?.trim()) {
          return json({ error: "Proxmox 연동에는 API 주소가 필요합니다." }, 400);
        }
        if (!body.pveTokenId?.trim() || !body.pveTokenSecret?.trim()) {
          return json({ error: "Proxmox API 토큰 ID와 비밀이 필요합니다. 노드는 비우면 전체가 긁힙니다." }, 400);
        }
      }

      const manage = assertHttpUrl(body.manageUrl || "", { allowEmpty: true, field: "관리 페이지 주소" });
      if (!manage.ok) return json({ error: manage.error }, 400);
      let pveHost: string | null = null;
      if (body.pveEnabled) {
        const pve = assertHttpUrl(body.pveHost || "", { field: "Proxmox API 주소" });
        if (!pve.ok) return json({ error: pve.error }, 400);
        pveHost = pve.url;
      }

      const { data: server, error } = await auth.sb!
        .from("servers")
        .insert({
          house_id: body.houseId,
          name: body.name.trim(),
          role: (body.role || "").trim(),
          // Default manage page to the PVE UI when the field was left empty.
          manage_url: manage.url || pveHost || "",
          wol_mode: wolMode,
          wol_mac: wol?.ok ? wol.mac : null,
          wol_broadcast: wol?.ok ? wol.broadcast : null,
          wol_port: wol?.ok ? wol.port : 9,
          pve_enabled: Boolean(body.pveEnabled),
          pve_host: pveHost,
          // null/empty = agent discovers every node under this API.
          pve_node: body.pveNode?.trim() || null,
          pve_token_id: body.pveTokenId?.trim() || null,
        })
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 400);

      const secret = body.pveTokenSecret?.trim();
      if (secret && body.pveEnabled) {
        const { error: secretError } = await auth.sb!.rpc("save_server_secret", {
          p_server_id: server.id,
          p_secret: secret,
        });
        if (secretError) return json({ error: secretError.message }, 400);
      }

      let syncQueued = false;
      if (body.pveEnabled) {
        const { error: jobError } = await auth.sb!.from("agent_jobs").insert({
          house_id: body.houseId,
          kind: "pve_sync",
          payload: { serverId: server.id },
        });
        syncQueued = !jobError;
      }

      return json({ server, syncQueued }, 201);
    }

    if (path.startsWith("/api/servers/") && req.method === "DELETE") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const id = path.split("/")[3];
      if (!isUuid(id)) return json({ error: "잘못된 서버 ID" }, 400);
      const { data, error } = await auth.sb!.from("servers").delete().eq("id", id).select("id");
      if (error) return json({ error: error.message }, 400);
      if (!data?.length) return json({ error: "서버를 찾을 수 없습니다." }, 404);
      return json({ ok: true });
    }

    if (path === "/api/services" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as ServiceInput & { houseId?: string; checkNow?: boolean };
      if (!isUuid(body.houseId)) return json({ error: "집이 필요합니다." }, 400);
      const parsed = parseServiceInput(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);

      const { data: dupe } = await auth.sb!
        .from("services")
        .select("id, name")
        .eq("house_id", body.houseId)
        .eq("health_url", parsed.row.health_url!)
        .limit(1)
        .maybeSingle();
      if (dupe) {
        return json({ error: `같은 헬스 체크 주소가 이미 '${dupe.name}'(으)로 등록되어 있습니다.` }, 409);
      }

      const { data: service, error } = await auth.sb!
        .from("services")
        .insert({ house_id: body.houseId, ...parsed.row })
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 400);

      let checkQueued = false;
      if (body.checkNow !== false) {
        const { error: jobError } = await auth.sb!.from("agent_jobs").insert({
          house_id: body.houseId,
          kind: "health_one",
          payload: { serviceId: service.id },
        });
        checkQueued = !jobError;
      }
      return json({ service, checkQueued }, 201);
    }

    if (path.startsWith("/api/services/") && req.method === "PATCH") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const id = path.split("/")[3];
      if (!isUuid(id)) return json({ error: "잘못된 서비스 ID" }, 400);
      const body = (await req.json()) as ServiceInput;
      const parsed = parseServiceInput(body, { partial: true });
      if (!parsed.ok) return json({ error: parsed.error }, 400);

      const { data: current } = await auth.sb!
        .from("services")
        .select("id, house_id, health_url, expect_status")
        .eq("id", id)
        .maybeSingle();
      if (!current) return json({ error: "서비스를 찾을 수 없습니다." }, 404);

      if (parsed.row.health_url && parsed.row.health_url !== current.health_url) {
        const { data: dupe } = await auth.sb!
          .from("services")
          .select("id, name")
          .eq("house_id", current.house_id)
          .eq("health_url", parsed.row.health_url)
          .neq("id", id)
          .limit(1)
          .maybeSingle();
        if (dupe) {
          return json({ error: `같은 헬스 체크 주소가 이미 '${dupe.name}'(으)로 등록되어 있습니다.` }, 409);
        }
      }

      const targetChanged =
        (parsed.row.health_url !== undefined && parsed.row.health_url !== current.health_url) ||
        (parsed.row.expect_status !== undefined && parsed.row.expect_status !== current.expect_status);
      // Old results describe the previous target; reset so the UI shows "미확인" until re-checked.
      const reset = targetChanged ? { last_ok: null, last_code: null, last_ms: null, last_checked_at: null } : {};

      const { data: service, error } = await auth.sb!
        .from("services")
        .update({ ...parsed.row, ...reset, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) return json({ error: error.message }, 400);
      if (!service) return json({ error: "서비스를 찾을 수 없습니다." }, 404);

      let checkQueued = false;
      if (targetChanged) {
        const { error: jobError } = await auth.sb!.from("agent_jobs").insert({
          house_id: current.house_id,
          kind: "health_one",
          payload: { serviceId: id },
        });
        checkQueued = !jobError;
      }
      return json({ service, checkQueued });
    }

    if (path.startsWith("/api/services/") && req.method === "DELETE") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const id = path.split("/")[3];
      if (!isUuid(id)) return json({ error: "잘못된 서비스 ID" }, 400);
      const { data, error } = await auth.sb!.from("services").delete().eq("id", id).select("id");
      if (error) return json({ error: error.message }, 400);
      if (!data?.length) return json({ error: "서비스를 찾을 수 없습니다." }, 404);
      return json({ ok: true });
    }

    if (path === "/api/jobs" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as {
        houseId: string;
        kind: "wake" | "health_all" | "health_one" | "pve_sync" | "speed_probe" | "agent_update";
        payload?: Record<string, unknown>;
      };
      if (!isUuid(body.houseId) || !JOB_KINDS.has(body.kind)) return json({ error: "잘못된 요청" }, 400);
      const { data: job, error } = await auth.sb!
        .from("agent_jobs")
        .insert({
          house_id: body.houseId,
          kind: body.kind,
          payload: body.payload || {},
        })
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 400);
      // Jobs are consumed by the home agent poller (Bearer AGENT_TOKEN).
      // No unauthenticated push endpoint — avoids DoS via anonymous /job.
      return json({ job });
    }

    if (path === "/api/agent/token" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as { houseId: string; agentUrl?: string; agentHostLabel?: string };
      if (!body.houseId) return json({ error: "집이 필요합니다." }, 400);
      const forbidden = await requireHouseOwner(auth.sb!, body.houseId);
      if (forbidden) return forbidden;

      let agentUrl: string | null = null;
      if (body.agentUrl?.trim()) {
        const checked = assertHttpUrl(body.agentUrl, { field: "에이전트 URL" });
        if (!checked.ok) return json({ error: checked.error }, 400);
        agentUrl = checked.url;
      }

      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const hash = await sha256Hex(token);
      const { error } = await auth.sb!
        .from("houses")
        .update({
          agent_token_hash: hash,
          agent_url: agentUrl,
          agent_host_label: body.agentHostLabel?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.houseId);
      if (error) return json({ error: error.message }, 400);
      return json({ token, shownOnce: true });
    }

    if (path === "/api/agent/poll" && req.method === "GET") {
      const token = bearer(req);
      if (!token) return json({ error: "unauthorized" }, 401);
      const sb = agentDb(env);
      const { data, error } = await sb.rpc("agent_poll", { p_token: token });
      if (error) {
        const status = /unauthorized/i.test(error.message) ? 401 : 400;
        return json({ error: error.message }, status);
      }
      return json(data);
    }

    if (path === "/api/agent/report" && req.method === "POST") {
      const token = bearer(req);
      if (!token) return json({ error: "unauthorized" }, 401);
      const body = (await req.json()) as {
        houseName?: string;
        services?: Array<{
          id?: string;
          name?: string;
          host?: string;
          url?: string;
          ok: boolean;
          code?: number;
          expect?: number;
          ms?: number;
          error?: string;
          slackOnFail?: boolean;
        }>;
        speed?: { down_mbps: number; up_mbps?: number };
        jobs?: Array<{ id?: string; kind?: string; status: string; error?: string }>;
      };
      const sb = agentDb(env);
      const { data, error } = await sb.rpc("agent_report", { p_token: token, p_payload: body });
      if (error) {
        const status = /unauthorized/i.test(error.message) ? 401 : 400;
        return json({ error: error.message }, status);
      }

      const house = (data as {
        house?: {
          name?: string;
          slack_channel?: string;
          speed_threshold_mbps?: number;
          alert_state?: Record<string, { since?: string; name?: string; kind?: string }>;
        };
      } | null)?.house;
      const channel = house?.slack_channel || "#homelab";
      const reportedServices = (body.services || []).map((s) => ({
        id: s.id,
        name: s.name || s.id || "서비스",
        host: s.host || null,
        url: s.url || null,
        ok: Boolean(s.ok),
        code: s.code ?? null,
        expect: s.expect ?? null,
        ms: s.ms ?? null,
        error: s.error || null,
        slackOnFail: s.slackOnFail !== false,
      }));
      const failedJobs = (body.jobs || []).filter((j) => j.status === "error");
      const threshold = house?.speed_threshold_mbps;
      const speedBelow =
        body.speed &&
        threshold != null &&
        Number(body.speed.down_mbps) < Number(threshold)
          ? {
              downMbps: Number(body.speed.down_mbps),
              thresholdMbps: Number(threshold),
              upMbps: body.speed.up_mbps != null ? Number(body.speed.up_mbps) : null,
            }
          : null;

      const deduped = dedupeAlerts({
        prev: house?.alert_state,
        services: reportedServices,
        speed: speedBelow,
        speedReported: body.speed != null,
        jobs: failedJobs,
      });

      if (deduped.hasFresh) {
        await notifySlack(
          env,
          channel,
          buildOpsAlert({
            houseName: body.houseName || house?.name,
            failingServices: deduped.freshServices,
            speed: deduped.freshSpeed,
            failedJobs: deduped.freshJobs,
          }),
        );
      }

      // Persist open incidents even when nothing fresh (recoveries clear keys).
      const prevJson = JSON.stringify(house?.alert_state || {});
      const nextJson = JSON.stringify(deduped.nextState);
      if (prevJson !== nextJson) {
        await sb.rpc("agent_set_alert_state", {
          p_token: token,
          p_state: deduped.nextState,
        });
      }

      return json(data || { ok: true });
    }

    if (path === "/api/invite" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as { houseId: string; email: string };
      const email = body.email?.trim().toLowerCase();
      if (!body.houseId || !email?.includes("@")) return json({ error: "이메일이 필요합니다." }, 400);
      const forbidden = await requireHouseOwner(auth.sb!, body.houseId);
      if (forbidden) return forbidden;

      // Allowlist + house invite; Auth user must still be created in Supabase Dashboard.
      const { error } = await auth.sb!.rpc("invite_house_member", {
        p_house_id: body.houseId,
        p_email: email,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, email, pending: true, provisionAllowlisted: true });
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "server error";
    return json({ error: message }, 500);
  }
}
