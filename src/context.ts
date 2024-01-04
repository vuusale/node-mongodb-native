import { resolveBSONOptions } from './bson';
import { type CommandOperationOptions, type OperationParent } from './operations/command';
import { ReadConcern } from './read_concern';
import { ReadPreference } from './read_preference';
import { type ServerDescription } from './sdam/server_description';
import { Timeouts } from './timeouts';
import { WriteConcern } from './write_concern';

/**
 * @internal
 */
export class Context<Options = CommandOperationOptions> {
  timeouts: Timeouts;
  serverDescription: ServerDescription | null = null;

  private constructor(public options: Options) {
    this.timeouts = new Timeouts(this.options as any);
  }

  static fromOptions<Options extends CommandOperationOptions>(
    parent: OperationParent | undefined | null,
    options: Options | undefined
  ): Context<Options> {
    const result: Options = {
      ...(options ?? ({} as Options)),
      ...resolveBSONOptions(options, parent)
    };

    // Users cannot pass a readConcern/writeConcern to operations in a transaction
    const session = options?.session;
    if (!session?.inTransaction()) {
      const readConcern = ReadConcern.fromOptions(options) ?? parent?.readConcern;
      if (readConcern) {
        result.readConcern = readConcern;
      }

      const writeConcern = WriteConcern.fromOptions(options) ?? parent?.writeConcern;
      if (writeConcern) {
        result.writeConcern = writeConcern;
      }
    }

    const readPreference = ReadPreference.fromOptions(options) ?? parent?.readPreference;
    if (readPreference) {
      result.readPreference = readPreference;
    }
    return new Context(result);
  }
}
