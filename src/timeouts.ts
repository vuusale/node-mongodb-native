import { clearTimeout, setTimeout } from 'timers';

import { promiseWithResolvers } from './utils';

const kTimeoutError = Symbol('isTimeoutError');
class TimeoutError extends Error {
  [kTimeoutError] = true;
  static isTimeoutError(error: unknown) {
    return (
      error != null && typeof error === 'object' && kTimeoutError in error && error[kTimeoutError]
    );
  }
}

export class Timeout {
  public id: Parameters<typeof clearTimeout>[0];
  public start: number;
  public timedOut = false;
  public didExpire = false;
  public expired: Promise<void>;
  public duration: number;

  private reject: (error: TimeoutError) => void;

  private constructor(duration: number) {
    this.duration = duration;
    const { reject, promise } = promiseWithResolvers<void>();
    this.reject = reject;
    this.start = performance.now();
    this.id = duration === 0 ? undefined : setTimeout(this.onTimeout.bind(this), duration);
    this.expired = promise;
  }

  private onTimeout() {
    this.didExpire = true;
    this.reject(new TimeoutError());
  }

  public static set(duration: number) {
    return new Timeout(duration);
  }

  // Promise<{ status: 'fulfilled'; value: T } | { status: 'expired'; value: null }>
  public async raceAgainstTheClock<T>(promise: Promise<T>): Promise<T> {
    try {
      const value = await Promise.race([promise, this.expired]);
      if (this.didExpire) {
        throw new Error('expired');
      }
      return value as unknown as T;
    } finally {
      this.clear();
    }
  }

  public clear() {
    clearTimeout(this.id);
  }

  public get timeRemaining(): number {
    const timePassed = performance.now() - this.start;
    return this.duration - timePassed;
  }
}

/**
 * @internal
 */
export class Timeouts {
  /** Maximum possible timeout value */
  static readonly MAX_TIMEOUT_VALUE = 0x7fff_ffff;
  static readonly INFINITE_TIMEOUT = 0;

  public readonly csotEnabled: boolean;

  public readonly defaultTimeoutMS: number;
  public readonly timeoutMS: number;

  public readonly wTimeoutMS: number;
  public readonly waitQueueTimeoutMS: number;
  public readonly socketTimeoutMS: number;
  public readonly maxTimeMS: number;
  public readonly maxCommitTimeMS: number;
  public readonly serverSelectionTimeoutMS: number;

  public minRoundTripTime = -1;

  /** The time at which the context began, this is only relevant to CSOT */
  public csot: Timeout;

  constructor({
    defaultTimeoutMS,
    timeoutMS,
    wTimeoutMS,
    waitQueueTimeoutMS,
    socketTimeoutMS,
    maxTimeMS,
    maxCommitTimeMS,
    serverSelectionTimeoutMS
  }: { [P in keyof Timeouts]?: Timeouts[P] | undefined | null } = {}) {
    this.csotEnabled = typeof defaultTimeoutMS === 'number' || typeof timeoutMS === 'number';

    this.defaultTimeoutMS = Timeouts.toTimeout(defaultTimeoutMS);
    this.timeoutMS = Timeouts.toTimeout(timeoutMS);
    this.wTimeoutMS = Timeouts.toTimeout(wTimeoutMS);
    this.waitQueueTimeoutMS = Timeouts.toTimeout(waitQueueTimeoutMS);
    this.socketTimeoutMS = Timeouts.toTimeout(socketTimeoutMS);
    this.maxTimeMS = Timeouts.toTimeout(maxTimeMS);
    this.maxCommitTimeMS = Timeouts.toTimeout(maxCommitTimeMS);
    this.serverSelectionTimeoutMS = Timeouts.toTimeout(serverSelectionTimeoutMS);

    this.csot = Timeout.set(this.timeoutMS);
  }

  /** Truncates number to integer and converts non-ints to MAX_TIMEOUT_VALUE */
  static toTimeout(value: unknown) {
    const truncNum = Math.trunc(Number(value));
    const int = Number.isSafeInteger(truncNum) ? truncNum : Timeouts.MAX_TIMEOUT_VALUE;
    return Math.min(int, Timeouts.MAX_TIMEOUT_VALUE);
  }

  serverSelectionTimeout(): Timeout {
    if (this.csotEnabled && this.timeoutMS < this.serverSelectionTimeoutMS) {
      return this.csot;
    }
    return Timeout.set(this.serverSelectionTimeoutMS);
  }

  connectionCheckoutTimeout() {
    if (this.csotEnabled) {
      return this.csot;
    }
    return Timeout.set(this.waitQueueTimeoutMS);
  }

  calculateMaxTimeMS(): number {
    if (!this.csotEnabled) throw new Error('misuse!');
    if (this.minRoundTripTime < this.timeoutMS) {
      return this.csotTimeout.tim;
    }
  }
}
