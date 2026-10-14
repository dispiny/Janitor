export type AgentErrorCode = "PUBLIC_IP_FAILED";

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
