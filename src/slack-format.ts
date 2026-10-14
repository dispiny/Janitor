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

function serviceLine(s: ServiceAlert): string {
  const where = s.host ? ` (${s.host})` : "";
  const got = s.code == null || s.code === 0 ? "응답 없음" : `HTTP ${s.code}`;
  const expect = s.expect != null ? ` · 기대 ${s.expect}` : "";
  const ms = s.ms != null ? ` · ${s.ms}ms` : "";
  const err = s.error ? `\n    ${truncate(s.error, 80)}` : "";
  const url = s.url ? `\n    ${truncate(s.url, 100)}` : "";
  return `• *${s.name}*${where} — DOWN\n    ${got}${expect}${ms}${url}${err}`;
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
    `*${house}* Worker 배포가 완료되었습니다.`,
    version ? `• 에이전트 버전 \`${version}\`` : null,
    host ? `• 호스트 \`${host}\`` : null,
    input.restartScheduled
      ? `• pm2 재시작 예약${pm2 ? ` (\`${pm2}\`)` : ""}`
      : null,
    note ? `• ${note}` : null,
  ].filter(Boolean) as string[];

  const text = `[${house}] Worker 배포 성공` + (version ? ` · v${version}` : "");

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
      ? `*죽은 서비스:* ${deadNames.map((n) => `\`${n}\``).join(", ")}`
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
      const kind = j.kind || "job";
      const err = j.error ? truncate(String(j.error), 100) : "오류";
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

  const fallbackParts = [
    `[${house}] ${problems.join(", ") || "알림"}`,
    deadNames.length ? `죽은 서비스: ${deadNames.join(", ")}` : null,
  ].filter(Boolean) as string[];
  for (const s of services.slice(0, 8)) {
    fallbackParts.push(
      `- DOWN ${s.name}: ${s.code == null || s.code === 0 ? "응답 없음" : `HTTP ${s.code}`}${s.expect != null ? ` (기대 ${s.expect})` : ""}`,
    );
  }
  if (speed) {
    fallbackParts.push(`- 회선: ${speed.downMbps} < ${speed.thresholdMbps} Mbps`);
  }
  for (const j of jobs.slice(0, 3)) {
    fallbackParts.push(`- ${j.kind || "job"}: ${j.error || "error"}`);
  }

  return {
    text: fallbackParts.join("\n"),
    blocks,
  };
}
