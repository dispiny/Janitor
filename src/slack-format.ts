export type ServiceAlert = {
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
  const where = s.host ? ` · ${s.host}` : "";
  const got = s.code == null ? "응답 없음" : `HTTP ${s.code}`;
  const expect = s.expect != null ? ` (기대 ${s.expect})` : "";
  const ms = s.ms != null ? ` · ${s.ms}ms` : "";
  const err = s.error ? ` · ${truncate(s.error, 80)}` : "";
  return `• *${s.name}*${where}\n    ${got}${expect}${ms}${err}`;
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

  const problems: string[] = [];
  if (services.length) problems.push(`헬스 ${services.length}`);
  if (speed) problems.push("회선 저하");
  if (jobs.length) problems.push(`작업 ${jobs.length}`);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `⚠ ${house} 문제 감지`, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `한눈에 볼 항목: *${problems.join(" · ") || "없음"}*`,
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
        text: `*헬스 체크 실패 (${services.length})*\n${lines.join("\n")}`,
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
        text: `${new Date().toISOString()} · ops alert`,
      },
    ],
  });

  const fallbackParts = [`[${house}] 문제: ${problems.join(", ") || "알림"}`];
  for (const s of services.slice(0, 5)) {
    fallbackParts.push(
      `- ${s.name}: ${s.code == null ? "응답 없음" : `HTTP ${s.code}`}${s.expect != null ? ` (기대 ${s.expect})` : ""}`,
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
