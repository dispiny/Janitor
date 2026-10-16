import { assertHttpUrl } from "./urls.ts";

export const SERVICE_NAME_MAX = 80;
export const SERVICE_HOST_MAX = 80;

export type ServiceInput = {
  name?: unknown;
  hostLabel?: unknown;
  healthUrl?: unknown;
  expectStatus?: unknown;
  manageUrl?: unknown;
  slackOnFail?: unknown;
  /** Send the agent's HEALTHCHECK_TOKEN as Bearer for this service only. */
  useHealthToken?: unknown;
};

export type ServiceRow = {
  name?: string;
  host_label?: string;
  health_url?: string;
  expect_status?: number;
  manage_url?: string;
  slack_on_fail?: boolean;
  use_health_token?: boolean;
};

export type ServiceParseResult = { ok: true; row: ServiceRow } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate a service create/update body. With `partial`, only provided keys are
 * checked and returned so PATCH can change one field without resending the rest.
 */
export function parseServiceInput(body: ServiceInput, options: { partial?: boolean } = {}): ServiceParseResult {
  const partial = Boolean(options.partial);
  const row: ServiceRow = {};
  const has = (key: keyof ServiceInput) => !partial || body[key] !== undefined;

  if (has("name")) {
    const name = text(body.name);
    if (!name) return { ok: false, error: "서비스 이름이 필요합니다." };
    if (name.length > SERVICE_NAME_MAX) {
      return { ok: false, error: `서비스 이름은 ${SERVICE_NAME_MAX}자 이하로 입력하세요.` };
    }
    row.name = name;
  }

  if (has("hostLabel")) {
    const host = text(body.hostLabel);
    if (host.length > SERVICE_HOST_MAX) {
      return { ok: false, error: `돌아가는 곳은 ${SERVICE_HOST_MAX}자 이하로 입력하세요.` };
    }
    row.host_label = host;
  }

  if (has("healthUrl")) {
    const health = assertHttpUrl(text(body.healthUrl), { field: "헬스 체크 주소" });
    if (!health.ok) return { ok: false, error: health.error };
    row.health_url = health.url;
  }

  if (has("expectStatus")) {
    const raw = body.expectStatus;
    const status = raw === "" || raw == null ? 200 : Number(raw);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return { ok: false, error: "기대 HTTP 상태는 100~599 사이 정수여야 합니다." };
    }
    row.expect_status = status;
  }

  if (has("manageUrl")) {
    const manage = assertHttpUrl(text(body.manageUrl), { allowEmpty: true, field: "관리 페이지 주소" });
    if (!manage.ok) return { ok: false, error: manage.error };
    row.manage_url = manage.url;
  }

  if (has("slackOnFail")) {
    row.slack_on_fail = body.slackOnFail !== false;
  }

  if (has("useHealthToken")) {
    // Opt-in: the token must never go to a URL the user did not mark.
    row.use_health_token = body.useHealthToken === true;
  }

  if (partial && Object.keys(row).length === 0) {
    return { ok: false, error: "바꿀 항목이 없습니다." };
  }
  return { ok: true, row };
}
