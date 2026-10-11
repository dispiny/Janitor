export type AgentErrorCode =
  | "UPLUS_NOT_CONFIGURED"
  | "UPLUS_DEVICE_REQUIRED"
  | "UPLUS_NOT_IMPLEMENTED"
  | "PUBLIC_IP_FAILED";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}
