import type { DaemonErrorCode, DaemonErrorResponse } from "@codex-fleet/shared";

export class FleetError extends Error {
  readonly code: DaemonErrorCode;
  readonly nextCall?: string;

  constructor(code: DaemonErrorCode, message: string, nextCall?: string) {
    super(message);
    this.name = "FleetError";
    this.code = code;
    this.nextCall = nextCall;
  }
}

export function errorResponse(error: unknown, requestId?: string): DaemonErrorResponse {
  if (error instanceof FleetError) {
    return {
      requestId,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        nextCall: error.nextCall
      }
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    requestId,
    ok: false,
    error: {
      code: "internal_error",
      message
    }
  };
}
