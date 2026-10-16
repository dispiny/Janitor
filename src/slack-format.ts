export type ServiceAlert = {
  id?: string;
  name: string;
  host?: string | null;
  url?: string | null;
  ok: boolean;
  code?: number | null;
  expect?: number | null;
  ms?: number | null;
  error?: string | null;
  slackOnFail?: boolean;
};

export type JobAlert = {
  id?: string;
  kind?: string;
  status: string;
  error?: string | null;
};

export type SlackMessage = {
  channel?: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
};

function truncate(text: string, max = 120): string {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Escape Slack mrkdwn control characters in user-provided text (names, hosts, urls, errors).
 * Without this a service named `<!channel>` or `<https://evil|click>` would ping or link.
 * Only for mrkdwn / top-level text; plain_text header blocks are rendered literally.
 */
export function escapeMrkdwn(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Truncate first, then escape, so an entity is never cut in half. */
function safe(text: unknown, max = 120): string {
  return escapeMrkdwn(truncate(String(text ?? ""), max));
}

function serviceLine(s: ServiceAlert): string {
  const where = s.host ? ` (${safe(s.host, 80)})` : "";
  const got = s.code == null || s.code === 0 ? "응답 없음" : `HTTP ${s.code}`;
  const expect = s.expect != null ? ` · 기대 ${s.expect}` : "";
  const ms = s.ms != null ? ` · ${s.ms}ms` : "";
  const err = s.error ? `\n    ${safe(s.error, 80)}` : "";
  const url = s.url ? `\n    ${safe(s.url, 100)}` : "";
  return `• *${safe(s.name, 80)}*${where} — DOWN\n    ${got}${expect}${ms}${url}${err}`;
}

/** Positive notice when remote update finished Worker `npm run deploy`. */
export function buildDeploySuccessMessage(input: {
  houseName?: string | null;
  agentVersion?: string | null;
  hostname?: string | null;
  pm2AppName?: string | null;
  restartScheduled?: boolean;
  note?: string | null;
}): SlackMessage {
  const house = (input.houseName || "").trim() || "집";
  const version = (input.agentVersion || "").trim();
  const host = (input.hostname || "").trim();
  const pm2 = (input.pm2AppName || "").trim();
  const note = truncate(String(input.note || ""), 160);

  const lines = [
    `*${escapeMrkdwn(house)}* Worker 배포가 완료되었습니다.`,
    version ? `• 에이전트 버전 \`${escapeMrkdwn(version)}\`` : null,
    host ? `• 호스트 \`${escapeMrkdwn(host)}\`` : null,
    input.restartScheduled
      ? `• pm2 재시작 예약${pm2 ? ` (\`${escapeMrkdwn(pm2)}\`)` : ""}`
      : null,
    note ? `• ${escapeMrkdwn(note)}` : null,
  ].filter(Boolean) as string[];

  const text = `[${escapeMrkdwn(house)}] Worker 배포 성공` + (version ? ` · v${escapeMrkdwn(version)}` : "");

  return {
    text,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `✅ ${house}: 배포 성공`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${new Date().toISOString()} · 대시보드 원격 업데이트 · 배포`,
          },
        ],
      },
    ],
  };
}

/** Build a readable Slack Block Kit alert for health / speed / job failures. */
export function buildOpsAlert(input: {
  houseName?: string | null;
  failingServices?: ServiceAlert[];
  speed?: { downMbps: number; thresholdMbps: number; upMbps?: number | null } | null;
  failedJobs?: JobAlert[];
}): SlackMessage {
  const house = (input.houseName || "").trim() || "집";
  const services = (input.failingServices || []).filter((s) => s.slackOnFail !== false);
  const jobs = (input.failedJobs || []).filter((j) => j.status === "error");
  const speed = input.speed || null;

  const deadNames = services.map((s) => s.name).filter(Boolean);
  const problems: string[] = [];
  if (deadNames.length) problems.push(`죽은 서비스 ${deadNames.length}`);
  if (speed) problems.push("회선 저하");
  if (jobs.length) problems.push(`작업 실패 ${jobs.length}`);

  const deadSummary =
    deadNames.length > 0
      ? `*죽은 서비스:* ${deadNames.map((n) => `\`${safe(n, 80)}\``).join(", ")}`
      : null;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: deadNames.length
          ? `⚠ ${house}: ${deadNames.slice(0, 3).join(", ")}${deadNames.length > 3 ? ` 외 ${deadNames.length - 3}` : ""} DOWN`
          : `⚠ ${house} 문제 감지`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [deadSummary, `요약: *${problems.join(" · ") || "없음"}*`].filter(Boolean).join("\n"),
      },
    },
  ];

  if (services.length) {
    const lines = services.slice(0, 15).map(serviceLine);
    if (services.length > 15) lines.push(`• _…외 ${services.length - 15}개_`);
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*다운된 서비스 (${services.length})*\n${lines.join("\n")}`,
      },
    });
  }

  if (speed) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*회선 속도 저하*",
          `• 다운로드 *${speed.downMbps} Mbps*  <  임계값 *${speed.thresholdMbps} Mbps*`,
          speed.upMbps != null ? `• 업로드 ${speed.upMbps} Mbps` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    });
  }

  if (jobs.length) {
    const lines = jobs.slice(0, 10).map((j) => {
      const kind = safe(j.kind || "job", 40);
      const err = j.error ? safe(j.error, 100) : "오류";
      return `• *${kind}* — ${err}`;
    });
    if (jobs.length > 10) lines.push(`• _…외 ${jobs.length - 10}개_`);
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*에이전트 작업 실패 (${jobs.length})*\n${lines.join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${new Date().toISOString()} · 동일 장애는 복구 전까지 다시 보내지 않음`,
      },
    ],
  });

  // Top-level text is parsed as mrkdwn too (notifications / fallback).
  const fallbackParts = [
    `[${escapeMrkdwn(house)}] ${problems.join(", ") || "알림"}`,
    deadNames.length ? `죽은 서비스: ${deadNames.map((n) => escapeMrkdwn(n)).join(", ")}` : null,
  ].filter(Boolean) as string[];
  for (const s of services.slice(0, 8)) {
    fallbackParts.push(
      `- DOWN ${escapeMrkdwn(s.name)}: ${s.code == null || s.code === 0 ? "응답 없음" : `HTTP ${s.code}`}${s.expect != null ? ` (기대 ${s.expect})` : ""}`,
    );
  }
  if (speed) {
    fallbackParts.push(`- 회선: ${speed.downMbps} < ${speed.thresholdMbps} Mbps`);
  }
  for (const j of jobs.slice(0, 3)) {
    fallbackParts.push(`- ${safe(j.kind || "job", 40)}: ${safe(j.error || "error", 160)}`);
  }

  return {
    text: fallbackParts.join("\n"),
    blocks,
  };
}

function formatKst(iso?: string | null): string {
  if (!iso) return "알 수 없음";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "알 수 없음";
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

/** One message for incidents that paged earlier and are now healthy (+ agent reconnect). */
export function buildRecoveryMessage(input: {
  houseName?: string | null;
  services?: Array<{ name: string; host?: string | null; since?: string | null }>;
  speed?: { since?: string | null } | null;
  agentReconnected?: { since?: string | null } | null;
}): SlackMessage {
  const house = (input.houseName || "").trim() || "집";
  const services = input.services || [];
  const parts: string[] = [];
  if (input.agentReconnected) parts.push("에이전트 다시 연결됨");
  if (services.length) parts.push(`서비스 ${services.length}개 복구됨`);
  if (input.speed) parts.push("회선 속도 복구됨");

  const lines: string[] = [];
  if (input.agentReconnected) {
    lines.push(`• *에이전트 다시 연결됨* (응답 없음 감지 ${formatKst(input.agentReconnected.since)})`);
  }
  for (const s of services.slice(0, 15)) {
    const where = s.host ? ` (${safe(s.host, 80)})` : "";
    lines.push(`• *${safe(s.name, 80)}*${where} — 복구됨${s.since ? ` · ${formatKst(s.since)}부터 장애` : ""}`);
  }
  if (services.length > 15) lines.push(`• _…외 ${services.length - 15}개_`);
  if (input.speed) lines.push("• *회선 속도* 임계값 이상으로 복구됨");

  const summary = parts.join(" · ") || "복구됨";
  return {
    text: `[${escapeMrkdwn(house)}] ${summary}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `✅ ${house}: ${summary}`, emoji: true },
      },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") || "복구됨" } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${new Date().toISOString()} · 이전에 알린 장애가 해소됨` }],
      },
    ],
  };
}

/** Cron: agent stopped polling/reporting. Sent once until the next successful report. */
export function buildAgentOfflineMessage(input: {
  houseName?: string | null;
  lastSeenAt?: string | null;
  hostLabel?: string | null;
}): SlackMessage {
  const house = (input.houseName || "").trim() || "집";
  const host = (input.hostLabel || "").trim();
  const last = formatKst(input.lastSeenAt);
  const lines = [
    `*${escapeMrkdwn(house)}* 홈 에이전트가 응답하지 않습니다.`,
    `• 마지막 연결 ${last}`,
    host ? `• 호스트 \`${safe(host, 80)}\`` : null,
    "• 헬스 체크·속도 측정·작업 처리가 멈춘 상태입니다. 에이전트 기기·pm2·네트워크를 확인하세요.",
  ].filter(Boolean) as string[];
  return {
    text: `[${escapeMrkdwn(house)}] 에이전트 응답 없음 (마지막 연결 ${last})`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `⚠ ${house}: 에이전트 응답 없음`, emoji: true },
      },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${new Date().toISOString()} · 다시 연결되면 한 번 알림` }],
      },
    ],
  };
}
