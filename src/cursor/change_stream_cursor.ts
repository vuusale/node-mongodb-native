import { BSONType, type Document, type Long, type Timestamp } from '../bson';
import {
  ChangeStream,
  type ChangeStreamDocument,
  type ChangeStreamEvents,
  type OperationTime,
  type ResumeToken
} from '../change_stream';
import { type MongoDBResponse } from '../cmap/wire_protocol/server_response';
import { INIT, RESPONSE } from '../constants';
import type { MongoClient } from '../mongo_client';
import type { TODO_NODE_3286 } from '../mongo_types';
import { AggregateOperation } from '../operations/aggregate';
import type { CollationOptions } from '../operations/command';
import { executeOperation, type ExecutionResult } from '../operations/execute_operation';
import type { ClientSession } from '../sessions';
import { maxWireVersion, type MongoDBNamespace } from '../utils';
import { AbstractCursor, type AbstractCursorOptions } from './abstract_cursor';

/** @internal */
export interface ChangeStreamCursorOptions extends AbstractCursorOptions {
  startAtOperationTime?: OperationTime;
  resumeAfter?: ResumeToken;
  startAfter?: ResumeToken;
  maxAwaitTimeMS?: number;
  collation?: CollationOptions;
  fullDocument?: string;
}

/** @internal */
export type ChangeStreamAggregateRawResult<TChange> = {
  $clusterTime: { clusterTime: Timestamp };
  cursor: {
    postBatchResumeToken: ResumeToken;
    ns: string;
    id: number | Long;
  } & ({ firstBatch: TChange[] } | { nextBatch: TChange[] });
  ok: 1;
  operationTime: Timestamp;
};

/** @internal */
export class ChangeStreamCursor<
  TSchema extends Document = Document,
  TChange extends Document = ChangeStreamDocument<TSchema>
> extends AbstractCursor<TChange, ChangeStreamEvents> {
  _resumeToken: ResumeToken;
  startAtOperationTime?: OperationTime | null;
  hasReceived?: boolean;
  resumeAfter: ResumeToken;
  startAfter: ResumeToken;
  options: ChangeStreamCursorOptions;

  postBatchResumeToken?: ResumeToken;
  pipeline: Document[];

  /**
   * @internal
   *
   * used to determine change stream resumability
   */
  maxWireVersion: number | undefined;

  constructor(
    client: MongoClient,
    namespace: MongoDBNamespace,
    pipeline: Document[] = [],
    options: ChangeStreamCursorOptions = {}
  ) {
    super(client, namespace, options);

    this.pipeline = pipeline;
    this.options = options;
    this._resumeToken = null;
    this.startAtOperationTime = options.startAtOperationTime;

    if (options.startAfter) {
      this.resumeToken = options.startAfter;
    } else if (options.resumeAfter) {
      this.resumeToken = options.resumeAfter;
    }
  }

  set resumeToken(token: ResumeToken) {
    this._resumeToken = token;
    this.emit(ChangeStream.RESUME_TOKEN_CHANGED, token);
  }

  get resumeToken(): ResumeToken {
    return this._resumeToken;
  }

  get resumeOptions(): ChangeStreamCursorOptions {
    const options: ChangeStreamCursorOptions = {
      ...this.options
    };

    for (const key of ['resumeAfter', 'startAfter', 'startAtOperationTime'] as const) {
      delete options[key];
    }

    if (this.resumeToken != null) {
      if (this.options.startAfter && !this.hasReceived) {
        options.startAfter = this.resumeToken;
      } else {
        options.resumeAfter = this.resumeToken;
      }
    } else if (this.startAtOperationTime != null && maxWireVersion(this.server) >= 7) {
      options.startAtOperationTime = this.startAtOperationTime;
    }

    return options;
  }

  cacheResumeToken(resumeToken: ResumeToken): void {
    if (this.bufferedCount() === 0 && this.postBatchResumeToken) {
      this.resumeToken = this.postBatchResumeToken;
    } else {
      this.resumeToken = resumeToken;
    }
    this.hasReceived = true;
  }

  _processBatch(response: MongoDBResponse): void {
    const cursor = response.getValue('cursor', BSONType.object, true);
    if (cursor.hasElement('postBatchResumeToken')) {
      const postBatchResumeToken = cursor
        .getValue('postBatchResumeToken', BSONType.object)
        ?.toObject();

      this.postBatchResumeToken = postBatchResumeToken;

      const batchLength =
        (
          cursor.getValue('firstBatch', BSONType.array) ??
          cursor.getValue('nextBatch', BSONType.array)
        )?.length ?? 0;

      if (batchLength === 0) {
        this.resumeToken = postBatchResumeToken;
      }
    }
  }

  clone(): AbstractCursor<TChange> {
    return new ChangeStreamCursor(this.client, this.namespace, this.pipeline, {
      ...this.cursorOptions
    });
  }

  async _initialize(session: ClientSession): Promise<ExecutionResult> {
    const aggregateOperation = new AggregateOperation(this.namespace, this.pipeline, {
      ...this.cursorOptions,
      ...this.options,
      session
    });

    const response = await executeOperation<TODO_NODE_3286, MongoDBResponse>(
      session.client,
      aggregateOperation
    );

    const server = aggregateOperation.server;
    this.maxWireVersion = maxWireVersion(server);

    if (
      this.startAtOperationTime == null &&
      this.resumeAfter == null &&
      this.startAfter == null &&
      this.maxWireVersion >= 7
    ) {
      this.startAtOperationTime = response.operationTime;
    }

    this._processBatch(response);

    this.emit(INIT, response);
    this.emit(RESPONSE);

    // TODO: NODE-2882
    return { server, session, response };
  }

  override async getMore(batchSize: number): Promise<Document | null> {
    const response = await super.getMore(batchSize);

    this.maxWireVersion = maxWireVersion(this.server);
    this._processBatch(response);

    this.emit(ChangeStream.MORE, response);
    this.emit(ChangeStream.RESPONSE);
    return response;
  }
}
