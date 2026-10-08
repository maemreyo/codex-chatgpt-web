import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";

const SAFETY_MARGIN_TOKENS = 4_096;
const MAX_ENTRIES = 128;

/** A rejection only tightens the future experimental single-message budget. */
export class SemanticMessageCeilings {
  private readonly ceilings = new Map<string, number>();
  private loaded = false;
  private persistenceFailed = false;

  constructor(private readonly path: string | undefined, private readonly accountNamespace: string) {}

  private key(mode: string, effort: string, tier: string): string {
    return createHash("sha256")
      .update(JSON.stringify([this.accountNamespace, mode, effort, tier]))
      .digest("hex");
  }

  private load(): void {
    if (this.persistenceFailed) {
      throw new ChatGptWebAdapterError(
        "The semantic message-ceiling rejection limit could not be persisted; refusing another browser submission.",
        { status: 409, errorType: "invalid_request_error", code: "semantic_message_ceiling_unpersisted", retryable: false },
      );
    }
    if (this.loaded) return;
    if (this.path && existsSync(this.path)) {
      let file: unknown;
      try { file = JSON.parse(readFileSync(this.path, "utf8")); }
      catch { throw this.invalidStore(); }
      if (!file || typeof file !== "object" || Array.isArray(file)) throw this.invalidStore();
      const stored = file as { version?: unknown; ceilings?: unknown };
      if (stored.version !== 1 || !stored.ceilings || typeof stored.ceilings !== "object"
        || Array.isArray(stored.ceilings)) throw this.invalidStore();
      for (const [key, value] of Object.entries(stored.ceilings)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(value) || (value as number) < 1) {
          throw this.invalidStore();
        }
        this.ceilings.set(key, value as number);
      }
      if (this.ceilings.size > MAX_ENTRIES) throw this.invalidStore();
    }
    this.loaded = true;
  }

  private invalidStore(): ChatGptWebAdapterError {
    return new ChatGptWebAdapterError(
      "The semantic message-ceiling state is invalid; refusing to discard measured rejection limits.",
      { status: 409, errorType: "invalid_request_error", code: "semantic_message_ceiling_invalid", retryable: false },
    );
  }

  ceiling(mode: string, effort: string, tier: string): number | undefined {
    this.load();
    return this.ceilings.get(this.key(mode, effort, tier));
  }

  assertWithin(mode: string, effort: string, tier: string, messageTokens: number): void {
    const ceiling = this.ceiling(mode, effort, tier);
    if (ceiling === undefined || messageTokens <= ceiling) return;
    throw new ChatGptWebAdapterError(
      `This semantic browser message is estimated at ${messageTokens} tokens, above the observed ${ceiling}-token rejection ceiling. Canonical compaction is required.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }

  observeRejection(mode: string, effort: string, tier: string, rejectedTokens: number): number | undefined {
    if (!Number.isSafeInteger(rejectedTokens) || rejectedTokens < 1) return undefined;
    this.load();
    const key = this.key(mode, effort, tier);
    const candidate = Math.max(1, rejectedTokens - SAFETY_MARGIN_TOKENS);
    const existing = this.ceilings.get(key);
    if (existing !== undefined && existing <= candidate) return existing;
    if (existing === undefined && this.ceilings.size >= MAX_ENTRIES) throw this.invalidStore();
    this.ceilings.delete(key);
    this.ceilings.set(key, candidate);
    if (this.path) {
      try {
        atomicWriteFile(this.path, `${JSON.stringify({ version: 1, ceilings: Object.fromEntries(this.ceilings) })}\n`, { durable: true });
      } catch (error) {
        // A rejected message tightens the safe budget immediately. If that
        // observation cannot be saved, no later prompt in this process may
        // proceed as though the on-disk ceiling were authoritative.
        this.persistenceFailed = true;
        throw error;
      }
    }
    return candidate;
  }
}
