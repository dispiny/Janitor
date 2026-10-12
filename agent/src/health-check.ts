export type HttpCheckInput = {
  url: string;
  expectStatus?: number;
  timeoutMs?: number;
  authorization?: string;
};

export type HttpCheckResult = {
  url: string;
  ok: boolean;
  status: number;
  expectStatus: number;
  ms: number;
  error?: string;
};

export async function checkHttp(input: HttpCheckInput): Promise<HttpCheckResult> {
  const expectStatus = input.expectStatus ?? 200;
  const timeoutMs = input.timeoutMs ?? 8000;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers();
    if (input.authorization) {
      headers.set("authorization", input.authorization);
    }

    const response = await fetch(input.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers,
    });
    const ms = Math.round(performance.now() - started);
    return {
      url: input.url,
      ok: response.status === expectStatus,
      status: response.status,
      expectStatus,
      ms,
    };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    return {
      url: input.url,
      ok: false,
      status: 0,
      expectStatus,
      ms,
      error: error instanceof Error ? error.message : "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
