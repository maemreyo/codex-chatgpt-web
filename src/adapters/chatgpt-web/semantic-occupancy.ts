import { estimateTokens } from "../../lib/token-estimate";

export type SemanticBatchPressureReason = "unknown_occupancy" | "atomic_result_oversize" | "accumulated_occupancy";

/** An estimate of physical retained-chat pressure; never used for logical Codex usage. */
export class SemanticEpochOccupancy {
  private readonly seen = new Set<string>();
  private totalTokens = 0;
  private outputChars = 0;
  private atLimit = false;

  constructor(
    readonly physicalLimit: number,
    public known: boolean,
    private readonly modelId: string,
  ) {}

  /** A lost retained tab is replaced with a new physical conversation under the
   * same logical epoch key. The old token ledger cannot describe that new tab. */
  resetForFreshConversation(): void {
    this.seen.clear();
    this.totalTokens = 0;
    this.outputChars = 0;
    this.atLimit = false;
    this.known = true;
  }

  get confidence(): "known" | "unknown" { return this.known && !this.atLimit ? "known" : "unknown"; }
  get value(): number | null { return this.known ? this.totalTokens : null; }

  record(id: string, tokens: number): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.totalTokens += Math.max(0, Math.ceil(tokens));
  }

  recordOutput(text: string): void {
    // One append-only DOM callback is counted once by the owning browser worker.
    this.outputChars += text.length;
    this.totalTokens += Math.ceil(this.outputChars / 3) - Math.ceil((this.outputChars - text.length) / 3);
  }

  markRejected(): void { this.atLimit = true; }

  /** Only a launcher lease explicitly marked as new proves the previous tab
   * is gone. The same key may now start a new physical occupancy window. */
  resetForVerifiedFreshLease(): void {
    this.seen.clear();
    this.totalTokens = 0;
    this.outputChars = 0;
    this.atLimit = false;
    this.known = true;
  }

  /** Canonical compaction may cross epoch pressure, but can never deliver an
   * individual result exceeding the model's entire physical working set. */
  canFitAtomicResults(results: readonly { content: unknown }[]): boolean {
    return results.every(item => (
      estimateTokens(JSON.stringify(item.content), this.modelId) + 12_288 < this.physicalLimit
    ));
  }

  /** Classify failure before any broker result is delivered; never include result content in telemetry. */
  batchPressureReason(results: readonly { callId: string; content: unknown }[]): SemanticBatchPressureReason | undefined {
    if (!this.canFitAtomicResults(results)) return "atomic_result_oversize";
    if (!this.known || this.atLimit) return "unknown_occupancy";
    const batchTokens = results.reduce((total, item) => total + estimateTokens(JSON.stringify(item.content), this.modelId), 0);
    // Fixed conservative allowance for browser wrappers and subsequent model output.
    return this.totalTokens + batchTokens + 12_288 < this.physicalLimit
      ? undefined : "accumulated_occupancy";
  }

  /** Atomically assess the complete batch before the first broker.completeTool. */
  canDeliverBatch(results: readonly { callId: string; content: unknown }[]): boolean {
    return this.batchPressureReason(results) === undefined;
  }

  recordToolResult(callId: string, content: unknown): void {
    this.record(`result:${callId}`, estimateTokens(JSON.stringify(content), this.modelId));
  }
}

/** Process-local only. A restart cannot prove the occupancy of an old retained chat. */
class SemanticEpochOccupancies {
  private readonly entries = new Map<string, SemanticEpochOccupancy>();
  // Keep a process-lifetime record even when an inactive ledger is evicted.
  // An old browser tab may still hold this key; its missing token count must
  // never be mistaken for a fresh, zero-occupancy conversation.
  private readonly issuedKeys = new Set<string>();

  forConversation(key: string, fresh: boolean, physicalLimit: number, modelId: string): SemanticEpochOccupancy {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const ledger = new SemanticEpochOccupancy(physicalLimit, fresh && !this.issuedKeys.has(key), modelId);
    this.issuedKeys.add(key);
    this.entries.set(key, ledger);
    while (this.entries.size > 512) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return ledger;
  }

  /**
   * A recreated direct worker may only start a zeroed ledger after its caller
   * has an independent fresh-conversation proof. The proof is represented by
   * this explicit API boundary; ordinary lookup remains fail-closed.
   */
  resetForVerifiedFreshLease(key: string, physicalLimit: number, modelId: string): SemanticEpochOccupancy {
    const ledger = this.forConversation(key, false, physicalLimit, modelId);
    ledger.resetForVerifiedFreshLease();
    return ledger;
  }
}

export const semanticEpochOccupancies = new SemanticEpochOccupancies();
