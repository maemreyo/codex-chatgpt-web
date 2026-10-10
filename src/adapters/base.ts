import type { AdapterEvent, CodexParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
}

export interface ProviderAdapter {
  name: string;
  /** Read-only rejection before HTTP stream headers; runTurn must retain its own guards. */
  preflightTurn?(parsed: CodexParsedRequest): Extract<AdapterEvent, { type: "error" }> | undefined;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
