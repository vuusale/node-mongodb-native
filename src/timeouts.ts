/**
 * @internal
 */
export class Timeouts {
  /** Maximum possible timeout value */
  static readonly MAX_TIMEOUT_VALUE = 0x7fff_ffff;

  public readonly csotEnabled: boolean;

  public readonly defaultTimeoutMS: number;
  public readonly timeoutMS: number;

  public readonly wTimeoutMS: number;
  public readonly waitQueueTimeoutMS: number;
  public readonly socketTimeoutMS: number;
  public readonly maxTimeMS: number;
  public readonly maxCommitTimeMS: number;
  public readonly serverSelectionTimeoutMS: number;

  constructor({
    defaultTimeoutMS,
    timeoutMS,
    wTimeoutMS,
    waitQueueTimeoutMS,
    socketTimeoutMS,
    maxTimeMS,
    maxCommitTimeMS,
    serverSelectionTimeoutMS
  }: { [P in keyof Timeouts]?: Timeouts[P] | undefined | null }) {
    this.csotEnabled = typeof defaultTimeoutMS === 'number' || typeof timeoutMS === 'number';
    this.defaultTimeoutMS = Timeouts.toTimeout(defaultTimeoutMS);
    this.timeoutMS = Timeouts.toTimeout(timeoutMS);
    this.wTimeoutMS = Timeouts.toTimeout(wTimeoutMS);
    this.waitQueueTimeoutMS = Timeouts.toTimeout(waitQueueTimeoutMS);
    this.socketTimeoutMS = Timeouts.toTimeout(socketTimeoutMS);
    this.maxTimeMS = Timeouts.toTimeout(maxTimeMS);
    this.maxCommitTimeMS = Timeouts.toTimeout(maxCommitTimeMS);
    this.serverSelectionTimeoutMS = Timeouts.toTimeout(serverSelectionTimeoutMS);
  }

  /** Truncates number to integer and converts non-ints to MAX_TIMEOUT_VALUE */
  static toTimeout(value: unknown) {
    const truncNum = Math.trunc(Number(value));
    const int = Number.isSafeInteger(truncNum) ? truncNum : Timeouts.MAX_TIMEOUT_VALUE;
    return Math.min(int, Timeouts.MAX_TIMEOUT_VALUE);
  }
}
