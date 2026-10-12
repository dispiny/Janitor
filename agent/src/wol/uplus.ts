import { AgentError } from "../errors.js";

export type UplusWakeInput = {
  device: string;
  routerUrl?: string;
  routerPassword?: string;
};

export type UplusWakeResult = {
  ok: true;
  mode: "uplus";
  device: string;
  note: string;
};

/**
 * U+ 공유기 WOL은 공유기 관리 UI/세션에 의존합니다.
 * 자격 증명이 없으면 설정 오류를 내고, 있으면 호출 자리만 남깁니다.
 * (실제 HTML/세션 흐름은 공유기 펌웨어에 맞춰 채웁니다.)
 */
export async function wakeViaUplus(input: UplusWakeInput): Promise<UplusWakeResult> {
  if (!input.routerUrl || !input.routerPassword) {
    throw new AgentError(
      "UPLUS_NOT_CONFIGURED",
      "UPLUS_ROUTER_URL and UPLUS_ROUTER_PASSWORD are required for uplus WOL",
    );
  }
  if (!input.device.trim()) {
    throw new AgentError("UPLUS_DEVICE_REQUIRED", "device name is required");
  }

  // Intentionally not implemented against a live router in this scaffold.
  // Cloud Worker should treat HTTP 501 as "agent ready, provider pending".
  throw new AgentError("UPLUS_NOT_IMPLEMENTED", "uplus WOL provider is not implemented yet");
}
