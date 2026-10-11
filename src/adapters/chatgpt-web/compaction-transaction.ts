import { createHash, randomBytes } from "node:crypto";

export interface CompactionTransactionHandle {
  token: string;
  handoffId: string;
}

interface TransactionWaiter {
  resolve: (summary: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface CompactionTransaction extends CompactionTransactionHandle {
  traceId: string;
  evidence?: Map<string, { canonical: string; sha256: string }>;
  summary?: string;
  waiter?: TransactionWaiter;
  timer?: ReturnType<typeof setTimeout>;
}

function opaqueId(prefix: "control" | "handoff"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** One-shot capability store for the summary only; it never owns a Codex tool environment. */
export class CompactionTransactionStore {
  private readonly transactions = new Map<string, CompactionTransaction>();

  begin(traceId: string, ttlMs: number): CompactionTransactionHandle {
    if (!traceId.trim()) throw new Error("compaction transaction trace id is required");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("compaction transaction TTL must be a positive finite number");
    }
    const transaction: CompactionTransaction = {
      token: opaqueId("control"),
      handoffId: opaqueId("handoff"),
      traceId,
    };
    transaction.timer = setTimeout(() => {
      this.finishError(transaction, new Error("compaction transaction timed out"));
    }, ttlMs);
    transaction.timer.unref?.();
    this.transactions.set(transaction.token, transaction);
    return { token: transaction.token, handoffId: transaction.handoffId };
  }

  /** Read-only evidence is scoped to this checkpoint and disappears with its one-shot control. */
  attachEvidence(token: string, handoffId: string, entries: readonly { callId: string; canonical: string }[]): void {
    const transaction = this.pending(token, handoffId);
    if (transaction.evidence) throw new Error("compaction evidence was already attached");
    const evidence = new Map<string, { canonical: string; sha256: string }>();
    for (const { callId, canonical } of entries) {
      if (!/^call_[A-Za-z0-9_-]+$/.test(callId) || typeof canonical !== "string"
        || canonical.length > 8_000_000 || evidence.has(callId)) {
        throw new Error("compaction evidence entry is invalid");
      }
      evidence.set(callId, { canonical, sha256: createHash("sha256").update(canonical).digest("hex") });
    }
    if ([...evidence.values()].reduce((total, item) => total + item.canonical.length, 0) > 24_000_000) {
      throw new Error("compaction evidence exceeds bounded reference capacity");
    }
    transaction.evidence = evidence;
  }

  readEvidence(token: string, handoffId: string, reference: string, offset: number, length: number) {
    const transaction = this.pending(token, handoffId);
    const entry = transaction.evidence?.get(reference);
    if (!entry) throw new Error("compaction evidence reference is unavailable");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.canonical.length
      || !Number.isSafeInteger(length) || length < 1 || length > 8_192) {
      throw new Error("compaction evidence read range is invalid");
    }
    const text = entry.canonical.slice(offset, offset + length);
    return { reference, offset, text, totalChars: entry.canonical.length,
      nextOffset: offset + text.length, done: offset + text.length === entry.canonical.length,
      sha256: entry.sha256 };
  }

  private pending(token: string, handoffId: string): CompactionTransaction {
    const transaction = this.transactions.get(token);
    if (!transaction || transaction.summary !== undefined || transaction.handoffId !== handoffId) {
      throw new Error("compaction control token is invalid, expired, or consumed");
    }
    return transaction;
  }

  submit(token: string, handoffId: string, summary: string): void {
    const transaction = this.transactions.get(token);
    if (!transaction) throw new Error("compaction control token is invalid, expired, or consumed");
    if (transaction.summary !== undefined) throw new Error("compaction handoff was already submitted");
    if (handoffId !== transaction.handoffId) {
      throw new Error("compaction handoff id does not match the pending transaction");
    }
    const normalized = summary.trim();
    if (!normalized) throw new Error("compaction handoff summary is empty");
    transaction.summary = normalized;
    console.info(`[chatgpt-web] broker trace=${transaction.traceId} accepted structured compaction handoff`);
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = undefined;
    if (transaction.waiter) this.consume(transaction);
  }

  wait(token: string, signal?: AbortSignal): Promise<string> {
    const transaction = this.transactions.get(token);
    if (!transaction) return Promise.reject(new Error("compaction control token is invalid, expired, or consumed"));
    if (transaction.waiter) return Promise.reject(new Error("compaction transaction already has a waiter"));
    if (transaction.summary !== undefined) return Promise.resolve(this.consume(transaction));
    if (signal?.aborted) {
      const error = new DOMException("compaction transaction aborted", "AbortError");
      this.finishError(transaction, error);
      return Promise.reject(error);
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: TransactionWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => this.finishError(
          transaction,
          new DOMException("compaction transaction aborted", "AbortError"),
        );
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      transaction.waiter = waiter;
    });
  }

  abort(token: string): void {
    const transaction = this.transactions.get(token);
    if (!transaction) return;
    if (transaction.summary !== undefined) {
      this.transactions.delete(token);
      if (transaction.timer) clearTimeout(transaction.timer);
      transaction.timer = undefined;
      this.detachWaiter(transaction);
      transaction.waiter = undefined;
      return;
    }
    this.finishError(transaction, new Error("compaction transaction aborted"));
  }

  abortTrace(traceId: string): void {
    for (const transaction of [...this.transactions.values()]) {
      if (transaction.traceId === traceId && transaction.summary === undefined) {
        this.finishError(transaction, new Error("compaction transaction was revoked"));
      }
    }
  }

  close(): void {
    for (const transaction of [...this.transactions.values()]) {
      this.finishError(transaction, new Error("compaction transaction broker closed"));
    }
  }

  private consume(transaction: CompactionTransaction): string {
    if (transaction.summary === undefined) throw new Error("compaction transaction is not ready");
    const summary = transaction.summary;
    const waiter = transaction.waiter;
    this.transactions.delete(transaction.token);
    this.detachWaiter(transaction);
    transaction.waiter = undefined;
    waiter?.resolve(summary);
    return summary;
  }

  private finishError(transaction: CompactionTransaction, error: Error): void {
    if (!this.transactions.delete(transaction.token)) return;
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = undefined;
    const waiter = transaction.waiter;
    this.detachWaiter(transaction);
    transaction.waiter = undefined;
    waiter?.reject(error);
  }

  private detachWaiter(transaction: CompactionTransaction): void {
    const waiter = transaction.waiter;
    if (waiter?.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}
