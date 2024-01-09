import { type BSONSerializeOptions, type Document, resolveBSONOptions } from '../bson';
import { type Context } from '../context';
import { MongoInvalidArgumentError } from '../error';
import { Explain, type ExplainOptions } from '../explain';
import { ReadConcern, type ReadConcernOptions } from '../read_concern';
import { ReadPreference, type ReadPreferenceLike } from '../read_preference';
import type { Server } from '../sdam/server';
import { MIN_SECONDARY_WRITE_WIRE_VERSION } from '../sdam/server_selection';
import type { ClientSession } from '../sessions';
import {
  commandSupportsReadConcern,
  decorateWithExplain,
  maxWireVersion,
  type MongoDBNamespace
} from '../utils';
import { WriteConcern, type WriteConcernOptions } from '../write_concern';

export const Aspect = {
  READ_OPERATION: Symbol('READ_OPERATION'),
  WRITE_OPERATION: Symbol('WRITE_OPERATION'),
  RETRYABLE: Symbol('RETRYABLE'),
  EXPLAINABLE: Symbol('EXPLAINABLE'),
  SKIP_COLLATION: Symbol('SKIP_COLLATION'),
  CURSOR_CREATING: Symbol('CURSOR_CREATING'),
  MUST_SELECT_SAME_SERVER: Symbol('MUST_SELECT_SAME_SERVER')
} as const;

/** @public */
export type Hint = string | Document;

/** @internal */
export interface OperationParent {
  s: { namespace: MongoDBNamespace };
  readConcern?: ReadConcern;
  writeConcern?: WriteConcern;
  readPreference?: ReadPreference;
  bsonOptions?: BSONSerializeOptions;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export interface OperationConstructor extends Function {
  aspects?: Set<symbol>;
}

/** @public */
export interface CollationOptions {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: string;
  strength?: number;
  numericOrdering?: boolean;
  alternate?: string;
  maxVariable?: string;
  backwards?: boolean;
  normalization?: boolean;
}

/** @public */
export type OperationOptions = BSONSerializeOptions &
  ReadConcernOptions &
  WriteConcernOptions &
  ExplainOptions & {
    maxTimeMS?: number;

    collation?: CollationOptions;
    /** Specify ClientSession for this command */
    session?: ClientSession;
    willRetryWrite?: boolean;

    /** The preferred read preference (ReadPreference.primary, ReadPreference.primary_preferred, ReadPreference.secondary, ReadPreference.secondary_preferred, ReadPreference.nearest). */
    readPreference?: ReadPreferenceLike;

    /**
     * Comment to apply to the operation.
     *
     * In server versions pre-4.4, 'comment' must be string.  A server
     * error will be thrown if any other type is provided.
     *
     * In server versions 4.4 and above, 'comment' can be any valid BSON type.
     */
    comment?: unknown;
    /** Should retry failed writes */
    retryWrites?: boolean;

    noResponse?: boolean;

    /** @internal Hints to `executeOperation` that this operation should not unpin on an ended transaction */
    bypassPinningCheck?: boolean;
    omitReadPreference?: boolean;

    /** @internal */
    dbName?: string;
  };

/**
 * This class acts as a parent class for any operation and is responsible for setting this.options,
 * as well as setting and getting a session.
 * Additionally, this class implements `hasAspect`, which determines whether an operation has
 * a specific aspect.
 * @internal
 */
export abstract class AbstractOperation<TResult = any, TOptions extends OperationOptions = any> {
  ctx: Context<TOptions>;

  readPreference: ReadPreference;
  bypassPinningCheck: boolean;
  trySecondaryWrite: boolean;
  bsonOptions: BSONSerializeOptions;
  session: ClientSession | undefined;
  explain: Explain | null;

  ns!: MongoDBNamespace;
  server!: Server;
  readConcern: ReadConcern | undefined;
  writeConcern: WriteConcern | undefined;

  get options(): TOptions {
    return this.ctx.options;
  }

  constructor(ctx: Context<TOptions>) {
    this.ctx = ctx;

    this.readPreference = this.hasAspect(Aspect.WRITE_OPERATION)
      ? ReadPreference.primary
      : ReadPreference.fromOptions(this.options) ?? ReadPreference.primary;

    // Pull the BSON serialize options from the already-resolved options
    this.bsonOptions = resolveBSONOptions(this.options);

    this.session = this.options.session != null ? this.options.session : undefined;

    this.bypassPinningCheck = !!this.options.bypassPinningCheck;
    this.trySecondaryWrite = false;

    this.readConcern = ReadConcern.fromOptions(this.options);
    this.writeConcern = WriteConcern.fromOptions(this.options);

    this.explain = null;
    if (this.hasAspect(Aspect.EXPLAINABLE)) {
      this.explain = Explain.fromOptions(this.options) ?? null;
    } else if (this.options?.explain != null) {
      throw new MongoInvalidArgumentError(`Option "explain" is not supported on this command`);
    }
  }

  /** Must match the first key of the command object sent to the server.
  Command name should be stateless (should not use 'this' keyword) */
  abstract get commandName(): string;

  abstract execute(server: Server, session: ClientSession | undefined): Promise<TResult>;

  hasAspect(aspect: symbol): boolean {
    const ctor = this.constructor as OperationConstructor;
    if (ctor.aspects == null) {
      return false;
    }

    return ctor.aspects.has(aspect);
  }

  get canRetryRead(): boolean {
    return true;
  }

  get canRetryWrite(): boolean {
    if (this.hasAspect(Aspect.EXPLAINABLE)) {
      return this.explain == null;
    }
    return true;
  }

  async executeCommand(
    server: Server,
    session: ClientSession | undefined,
    cmd: Document
  ): Promise<Document> {
    // TODO: consider making this a non-enumerable property
    this.server = server;

    const options = {
      ...this.options,
      ...this.bsonOptions,
      readPreference: this.readPreference,
      session
    };

    const serverWireVersion = maxWireVersion(server);
    const inTransaction = this.session && this.session.inTransaction();

    if (this.readConcern && commandSupportsReadConcern(cmd) && !inTransaction) {
      Object.assign(cmd, { readConcern: this.readConcern });
    }

    if (this.trySecondaryWrite && serverWireVersion < MIN_SECONDARY_WRITE_WIRE_VERSION) {
      options.omitReadPreference = true;
    }

    if (this.writeConcern && this.hasAspect(Aspect.WRITE_OPERATION) && !inTransaction) {
      WriteConcern.apply(cmd, this.writeConcern);
    }

    if (
      options.collation &&
      typeof options.collation === 'object' &&
      !this.hasAspect(Aspect.SKIP_COLLATION)
    ) {
      Object.assign(cmd, { collation: options.collation });
    }

    if (!this.ctx.timeouts.csotEnabled && typeof options.maxTimeMS === 'number') {
      cmd.maxTimeMS = options.maxTimeMS;
    }

    if (this.hasAspect(Aspect.EXPLAINABLE) && this.explain) {
      cmd = decorateWithExplain(cmd, this.explain);
    }

    this.ctx.options = options;

    return server.commandAsync(this.ns, cmd, this.ctx);
  }
}

export function defineAspects(
  operation: OperationConstructor,
  aspects: symbol | symbol[] | Set<symbol>
): Set<symbol> {
  if (!Array.isArray(aspects) && !(aspects instanceof Set)) {
    aspects = [aspects];
  }

  aspects = new Set(aspects);
  Object.defineProperty(operation, 'aspects', {
    value: aspects,
    writable: false
  });

  return aspects;
}
