import { estimateTokens } from "../../lib/token-estimate";

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

  /** Canonical compaction may cross epoch pressure, but can never deliver an
   * individual result exceeding the model's entire physical working set. */
  canFitAtomicResults(results: readonly { content: unknown }[]): boolean {
    return results.every(item => (
      estimateTokens(JSON.stringify(item.content), this.modelId) + 12_288 < this.physicalLimit
    ));
  }

  /** Atomically assess the complete batch before the first broker.completeTool. */
  canDeliverBatch(results: readonly { callId: string; content: unknown }[]): boolean {
    if (!this.known || this.atLimit) return false;
    if (!this.canFitAtomicResults(results)) return false;
    const batchTokens = results.reduce((total, item) => total + estimateTokens(JSON.stringify(item.content), this.modelId), 0);
    // Fixed conservative allowance for browser wrappers and subsequent model output.
    return this.totalTokens + batchTokens + 12_288 < this.physicalLimit;
  }

  recordToolResult(callId: string, content: unknown): void {
    this.record(`result:${callId}`, estimateTokens(JSON.stringify(content), this.modelId));
  }
}

/** Process-local only. A restart cannot prove the occupancy of an old retained chat. */
class SemanticEpochOccupancies {
  private readonly entries = new Map<string, SemanticEpochOccupancy>();

  forConversation(key: string, fresh: boolean, physicalLimit: number, modelId: string): SemanticEpochOccupancy {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const ledger = new SemanticEpochOccupancy(physicalLimit, fresh, modelId);
    this.entries.set(key, ledger);
    while (this.entries.size > 512) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return ledger;
  }
}

export const semanticEpochOccupancies = new SemanticEpochOccupancies();
