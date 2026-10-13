import type { Env } from "./env";
import { notifySlack } from "./slack";
import { sha256Hex, userClient } from "./supabase";
import { createClient } from "@supabase/supabase-js";

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

function anonClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireUser(env: Env, req: Request) {
  const token = bearer(req);
  if (!token) return { error: json({ error: "unauthorized" }, 401) };
  const sb = userClient(env, token);
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return { error: json({ error: "unauthorized" }, 401) };
  return { sb, user: data.user, token };
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
      };
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        slackConfigured: Boolean(env.SLACK_WEBHOOK_URL),
        inviteOnly: status.inviteOnly !== false,
        bootstrapAllowed: Boolean(status.bootstrapAllowed),
        inviteHookReady: Boolean(status.hookReady),
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
        wolMode: "off" | "uplus" | "manual";
        wolUplusDevice?: string;
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
      if (body.wolMode === "uplus" && !body.wolUplusDevice?.trim()) {
        return json({ error: "U+ 공유기에 등록된 장치 이름이 필요합니다." }, 400);
      }
      if (body.wolMode === "manual" && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(body.wolMac || "")) {
        return json({ error: "수동 등록에는 MAC 주소가 필요합니다." }, 400);
      }
      if (body.pveEnabled && (!body.pveHost?.trim() || !body.pveNode?.trim())) {
        return json({ error: "Proxmox 연동에는 API 주소와 노드 이름이 필요합니다." }, 400);
      }

      const { data: server, error } = await auth.sb!
        .from("servers")
        .insert({
          house_id: body.houseId,
          name: body.name.trim(),
          role: (body.role || "").trim(),
          manage_url: (body.manageUrl || "").trim(),
          wol_mode: body.wolMode,
          wol_uplus_device: body.wolUplusDevice?.trim() || null,
          wol_mac: body.wolMac?.trim() || null,
          wol_broadcast: body.wolBroadcast?.trim() || null,
          wol_port: body.wolPort ?? 9,
          pve_enabled: Boolean(body.pveEnabled),
          pve_host: body.pveHost?.trim() || null,
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

      return json({ server });
    }

    if (path.startsWith("/api/servers/") && req.method === "DELETE") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const id = path.split("/")[3];
      const { error } = await auth.sb!.from("servers").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (path === "/api/services" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as {
        houseId: string;
        name: string;
        hostLabel?: string;
        healthUrl: string;
        expectStatus?: number;
        manageUrl?: string;
        slackOnFail?: boolean;
      };
      if (!body.houseId || !body.name?.trim() || !/^https?:\/\//.test(body.healthUrl || "")) {
        return json({ error: "이름과 http(s) 헬스 체크 주소가 필요합니다." }, 400);
      }
      const { data: service, error } = await auth.sb!
        .from("services")
        .insert({
          house_id: body.houseId,
          name: body.name.trim(),
          host_label: (body.hostLabel || "").trim(),
          health_url: body.healthUrl.trim(),
          expect_status: body.expectStatus || 200,
          manage_url: (body.manageUrl || "").trim(),
          slack_on_fail: body.slackOnFail !== false,
        })
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 400);
      return json({ service });
    }

    if (path.startsWith("/api/services/") && req.method === "DELETE") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const id = path.split("/")[3];
      const { error } = await auth.sb!.from("services").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (path === "/api/jobs" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as {
        houseId: string;
        kind: "wake" | "health_all" | "health_one" | "pve_sync" | "speed_probe";
        payload?: Record<string, unknown>;
      };
      if (!body.houseId || !body.kind) return json({ error: "잘못된 요청" }, 400);
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
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const hash = await sha256Hex(token);
      const { error } = await auth.sb!
        .from("houses")
        .update({
          agent_token_hash: hash,
          agent_url: body.agentUrl?.trim() || null,
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
      const sb = anonClient(env);
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
        services?: Array<{ ok: boolean }>;
        speed?: { down_mbps: number };
      };
      const sb = anonClient(env);
      const { data, error } = await sb.rpc("agent_report", { p_token: token, p_payload: body });
      if (error) {
        const status = /unauthorized/i.test(error.message) ? 401 : 400;
        return json({ error: error.message }, status);
      }

      const house = (data as { house?: { slack_channel?: string; speed_threshold_mbps?: number } } | null)?.house;
      const channel = house?.slack_channel || "#homelab";
      const failing = (body.services || []).filter((s) => !s.ok);
      if (failing.length) {
        await notifySlack(env, channel, `${failing.length}개 서비스 헬스 체크가 기대 응답이 아닙니다.`);
      }
      if (
        body.speed &&
        house?.speed_threshold_mbps != null &&
        Number(body.speed.down_mbps) < Number(house.speed_threshold_mbps)
      ) {
        await notifySlack(
          env,
          channel,
          `다운로드 ${body.speed.down_mbps} Mbps가 임계값 ${house.speed_threshold_mbps} Mbps보다 낮습니다.`,
        );
      }

      return json(data || { ok: true });
    }

    if (path === "/api/invite" && req.method === "POST") {
      const auth = await requireUser(env, req);
      if ("error" in auth && auth.error) return auth.error;
      const body = (await req.json()) as { houseId: string; email: string };
      const email = body.email?.trim().toLowerCase();
      if (!body.houseId || !email?.includes("@")) return json({ error: "이메일이 필요합니다." }, 400);

      const { error } = await auth.sb!.from("house_invites").upsert({
        house_id: body.houseId,
        email,
        invited_by: auth.user!.id,
      }, { onConflict: "house_id,email" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, email, pending: true });
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "server error";
    return json({ error: message }, 500);
  }
}
