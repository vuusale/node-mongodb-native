import type { Document } from '../bson';
import { type Context } from '../context';
import type { Server } from '../sdam/server';
import type { ClientSession } from '../sessions';
import { AggregateOperation, type AggregateOptions } from './aggregate';

/** @public */
export interface CountDocumentsOptions extends AggregateOptions {
  /** The number of documents to skip. */
  skip?: number;
  /** The maximum amounts to count before aborting. */
  limit?: number;
}

/** @internal */
export class CountDocumentsOperation extends AggregateOperation<number> {
  constructor(ctx: Context<CountDocumentsOptions>) {
    const pipeline = [];
    pipeline.push({ $match: ctx.get('query') });

    if (typeof ctx.options.skip === 'number') {
      pipeline.push({ $skip: ctx.options.skip });
    }

    if (typeof ctx.options.limit === 'number') {
      pipeline.push({ $limit: ctx.options.limit });
    }

    pipeline.push({ $group: { _id: 1, n: { $sum: 1 } } });

    ctx.set('pipeline', pipeline);

    super(ctx);
  }

  override async execute(server: Server, session: ClientSession | undefined): Promise<number> {
    const result = await super.execute(server, session);

    // NOTE: We're avoiding creating a cursor here to reduce the callstack.
    const response = result as unknown as Document;
    if (response.cursor == null || response.cursor.firstBatch == null) {
      return 0;
    }

    const docs = response.cursor.firstBatch;
    return docs.length ? docs[0].n : 0;
  }
}
