import type { Document } from '../bson';
import { type Context } from '../context';
import { MongoInvalidArgumentError } from '../error';
import { type TODO_NODE_3286 } from '../mongo_types';
import type { Server } from '../sdam/server';
import type { ClientSession } from '../sessions';
import { maxWireVersion, type MongoDBNamespace } from '../utils';
import { WriteConcern } from '../write_concern';
import {
  AbstractOperation,
  Aspect,
  defineAspects,
  type Hint,
  type OperationOptions
} from './operation';

/** @internal */
export const DB_AGGREGATE_COLLECTION = 1 as const;
const MIN_WIRE_VERSION_$OUT_READ_CONCERN_SUPPORT = 8 as const;

/** @public */
export interface AggregateOptions extends OperationOptions {
  /** allowDiskUse lets the server know if it can use disk to store temporary results for the aggregation (requires mongodb 2.6 \>). */
  allowDiskUse?: boolean;
  /** The number of documents to return per batch. See [aggregation documentation](https://www.mongodb.com/docs/manual/reference/command/aggregate). */
  batchSize?: number;
  /** Allow driver to bypass schema validation. */
  bypassDocumentValidation?: boolean;
  /** Return the query as cursor, on 2.6 \> it returns as a real cursor on pre 2.6 it returns as an emulated cursor. */
  cursor?: Document;
  /** specifies a cumulative time limit in milliseconds for processing operations on the cursor. MongoDB interrupts the operation at the earliest following interrupt point. */
  maxTimeMS?: number;
  /** The maximum amount of time for the server to wait on new documents to satisfy a tailable cursor query. */
  maxAwaitTimeMS?: number;
  /** Add an index selection hint to an aggregation command */
  hint?: Hint;
  /** Map of parameter names and values that can be accessed using $$var (requires MongoDB 5.0). */
  let?: Document;

  out?: string;
}

/** @internal */
export class AggregateOperation<T = Document> extends AbstractOperation<T, AggregateOptions> {
  target: string | typeof DB_AGGREGATE_COLLECTION;
  pipeline: Document[];
  hasWriteStage: boolean;

  constructor(ctx: Context<AggregateOptions>) {
    super(ctx);

    // Covers when ns.collection is null, undefined or the empty string, use DB_AGGREGATE_COLLECTION
    this.target = ctx.get<MongoDBNamespace>('ns').collection || DB_AGGREGATE_COLLECTION;

    this.pipeline = ctx.get('pipeline');

    // determine if we have a write stage, override read preference if so
    this.hasWriteStage = false;
    if (typeof this.options?.out === 'string') {
      this.pipeline = this.pipeline.concat({ $out: this.options.out });
      this.hasWriteStage = true;
    } else if (this.pipeline.length > 0) {
      const finalStage = this.pipeline[this.pipeline.length - 1];
      if (finalStage.$out || finalStage.$merge) {
        this.hasWriteStage = true;
      }
    }

    if (this.hasWriteStage) {
      this.trySecondaryWrite = true;
    } else {
      delete this.options.writeConcern;
    }

    if (this.explain && this.writeConcern) {
      throw new MongoInvalidArgumentError(
        'Option "explain" cannot be used on an aggregate call with writeConcern'
      );
    }

    if (this.options?.cursor != null && typeof this.options.cursor !== 'object') {
      throw new MongoInvalidArgumentError('Cursor options must be an object');
    }
  }

  override get commandName() {
    return 'aggregate' as const;
  }

  override get canRetryRead(): boolean {
    return !this.hasWriteStage;
  }

  addToPipeline(stage: Document): void {
    this.pipeline.push(stage);
  }

  override async execute(server: Server, session: ClientSession | undefined): Promise<T> {
    const options: AggregateOptions = this.options;
    const serverWireVersion = maxWireVersion(server);
    const command: Document = { aggregate: this.target, pipeline: this.pipeline };

    if (this.hasWriteStage && serverWireVersion < MIN_WIRE_VERSION_$OUT_READ_CONCERN_SUPPORT) {
      this.readConcern = undefined;
    }

    if (this.hasWriteStage && this.writeConcern) {
      WriteConcern.apply(command, this.writeConcern);
    }

    if (options.bypassDocumentValidation === true) {
      command.bypassDocumentValidation = options.bypassDocumentValidation;
    }

    if (typeof options.allowDiskUse === 'boolean') {
      command.allowDiskUse = options.allowDiskUse;
    }

    if (options.hint) {
      command.hint = options.hint;
    }

    if (options.let) {
      command.let = options.let;
    }

    // we check for undefined specifically here to allow falsy values
    // eslint-disable-next-line no-restricted-syntax
    if (options.comment !== undefined) {
      command.comment = options.comment;
    }

    command.cursor = options.cursor || {};
    if (options.batchSize && !this.hasWriteStage) {
      command.cursor.batchSize = options.batchSize;
    }

    return super.executeCommand(server, session, command) as TODO_NODE_3286;
  }
}

defineAspects(AggregateOperation, [
  Aspect.READ_OPERATION,
  Aspect.RETRYABLE,
  Aspect.EXPLAINABLE,
  Aspect.CURSOR_CREATING
]);
