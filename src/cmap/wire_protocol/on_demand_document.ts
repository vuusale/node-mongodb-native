import {
  Binary,
  BSON,
  type BSONElement,
  type BSONSerializeOptions,
  BSONType,
  ObjectId,
  parseToElementsToArray,
  Timestamp
} from '../../bson';
import { MongoUnexpectedServerResponseError } from '../../error';
import { ByteUtils } from '../../utils';

// eslint-disable-next-line no-restricted-syntax
const enum BSONElementOffset {
  type = 0,
  nameOffset = 1,
  nameLength = 2,
  offset = 3,
  length = 4
}

class ElementFinder {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {} // Using a class just to box up caching API. Shouldn't be instantiated.

  static cache: Record<string, Uint8Array> = Object.create(null);

  /** Assumes you are finding an element name that is basic latin ONLY */
  static isElementName(name: string, bytes: Uint8Array, element: BSONElement) {
    if (this.cache[name] == null) {
      this.cache[name] = new Uint8Array([...name].map(c => c.charCodeAt(0)));
    }
    const nameOffset = element[BSONElementOffset.nameOffset];
    const nameLength = element[BSONElementOffset.nameLength];
    return ByteUtils.compare(this.cache[name], bytes, nameOffset, nameOffset + nameLength) === 0;
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const getInt32LE = BSON.onDemand.NumberUtils.getInt32LE;
// eslint-disable-next-line @typescript-eslint/unbound-method
const getFloat64LE = BSON.onDemand.NumberUtils.getFloat64LE;
// eslint-disable-next-line @typescript-eslint/unbound-method
const getBigInt64LE = BSON.onDemand.NumberUtils.getBigInt64LE;
const toUTF8 = BSON.onDemand.ByteUtils.toUTF8;

/** @internal */
export type BSONTypeMap = {
  [BSONType.double]: number;
  [BSONType.int]: number;
  [BSONType.long]: bigint;
  [BSONType.timestamp]: Timestamp;
  [BSONType.binData]: Binary;
  [BSONType.bool]: boolean;
  [BSONType.objectId]: ObjectId;
  [BSONType.string]: string;
  [BSONType.date]: Date;

  [BSONType.object]: OnDemandDocument;
  [BSONType.array]: OnDemandDocument;

  //   [BSONType.undefined]: number;
  //   [BSONType.null]: number;
  //   [BSONType.regex]: number;
  //   [BSONType.dbPointer]: number;
  //   [BSONType.javascript]: number;
  //   [BSONType.symbol]: number;
  //   [BSONType.javascriptWithScope]: number;
  //   [BSONType.decimal]: number;
  //   [BSONType.minKey]: number;
  //   [BSONType.maxKey]: number;
};

/** @internal */
export class OnDemandDocument {
  private existsCache = Object.create(null);
  private valueCache = Object.create(null);
  private elementCache = Object.create(null);
  private topLevelElements: BSONElement[];
  get length() {
    return this.topLevelElements.length;
  }
  constructor(protected bson: Uint8Array, private offset = 0, public isArray = false) {
    this.topLevelElements = parseToElementsToArray(this.bson, offset);
  }

  private getElement(name: string): BSONElement | null {
    if (this.elementCache[name] != null) {
      return this.elementCache[name];
    }

    for (const element of this.topLevelElements) {
      if (ElementFinder.isElementName(name, this.bson, element))
        return (this.elementCache[name] = element);
    }
    return null;
  }

  private reviveValue(element: BSONElement, as: keyof BSONTypeMap) {
    const offset = element[BSONElementOffset.offset];
    const length = element[BSONElementOffset.length];

    switch (as) {
      case BSONType.int:
        return getInt32LE(this.bson, offset);
      case BSONType.long:
        return getBigInt64LE(this.bson, offset);
      case BSONType.bool:
        return Boolean(this.bson[offset]);
      case BSONType.objectId:
        return new ObjectId(this.bson.subarray(offset, offset + 12));
      case BSONType.timestamp:
        return new Timestamp(getBigInt64LE(this.bson, offset));
      case BSONType.string:
        return toUTF8(this.bson, offset + 4, offset + length - 1, false);
      case BSONType.binData: {
        const totalBinarySize = getInt32LE(this.bson, offset);
        const subType = this.bson[offset + 4];

        if (subType === 2) {
          const subType2BinarySize = getInt32LE(this.bson, offset + 1 + 4);
          if (subType2BinarySize < 0)
            throw new Error('Negative binary type element size found for subtype 0x02');
          if (subType2BinarySize > totalBinarySize - 4)
            throw new Error('Binary type with subtype 0x02 contains too long binary size');
          if (subType2BinarySize < totalBinarySize - 4)
            throw new Error('Binary type with subtype 0x02 contains too short binary size');
          return new Binary(
            this.bson.subarray(offset + 1 + 4 + 4, offset + 1 + 4 + 4 + subType2BinarySize),
            2
          );
        }

        return new Binary(
          this.bson.subarray(offset + 1 + 4, offset + 1 + 4 + totalBinarySize),
          subType
        );
      }
      case BSONType.date:
        // Pretend this is correct.
        return new Date(Number(getBigInt64LE(this.bson, offset)));

      case BSONType.object:
        return new OnDemandDocument(this.bson, offset);
      case BSONType.array:
        return new OnDemandDocument(this.bson, offset, true);

      default:
        throw new Error('unknown');
    }
  }

  public hasElement(name: string): boolean {
    if (name in this.existsCache) return this.existsCache[name];
    this.existsCache[name] = this.getElement(name) != null;
    return this.existsCache[name];
  }

  public getValue<T extends keyof BSONTypeMap, const Req extends boolean = false>(
    name: string,
    as: T,
    required?: Req
  ): Req extends true ? BSONTypeMap[T] : BSONTypeMap[T] | null;
  public getValue<T extends keyof BSONTypeMap>(name: string, as: T, required?: boolean): any {
    if (this.existsCache[name] === false) {
      // must strictly check eq to false
      if (required === true) {
        throw new MongoUnexpectedServerResponseError(`BSON element "${name}" is missing`);
      } else {
        return null;
      }
    }

    if (!(name in this.valueCache)) {
      const element = this.getElement(name);
      if (element == null) {
        this.existsCache[name] = false;
        if (required === true) {
          throw new MongoUnexpectedServerResponseError(`BSON element "${name}" is missing`);
        } else {
          return null;
        }
      }
      this.existsCache[name] = true;
      this.valueCache[name] = this.reviveValue(element, as);
    }
    return this.valueCache[name];
  }

  /**
   * Parses: int, double, long, bool
   * long will be a bigint cast to number
   * bool will be clamped to 1 or 0
   */
  public getFlexibleNumber<const Req>(
    name: string,
    required?: Req
  ): Req extends true ? number : number | null;
  public getFlexibleNumber(name: string, required?: boolean): number | null {
    if (name in this.valueCache) return this.valueCache[name];

    const element = this.getElement(name);
    if (element == null) {
      if (required === true) {
        throw new MongoUnexpectedServerResponseError(`BSON element "${name}" is missing`);
      } else {
        return null;
      }
    }

    const type = element[BSONElementOffset.type];
    const offset = element[BSONElementOffset.offset];
    if (type === BSONType.int) {
      this.valueCache[name] = getInt32LE(this.bson, offset);
    }
    if (type === BSONType.double) {
      this.valueCache[name] = getFloat64LE(this.bson, offset);
    }
    if (type === BSONType.long) {
      this.valueCache[name] = Number(getBigInt64LE(this.bson, offset));
    }
    if (type === BSONType.bool) {
      this.valueCache[name] = this.bson[offset] ? 1 : 0;
    }
    return this.valueCache[name] ?? null;
  }

  toObject(options?: BSONSerializeOptions): any {
    return BSON.deserialize(this.bson, {
      ...options,
      index: this.offset,
      allowObjectSmallerThanBufferSize: true
    });
  }

  toArray(options?: BSONSerializeOptions): Array<any> {
    if (!this.isArray) throw new Error('u sure?');
    return Array.from(Object.values(this.toObject(options)));
  }
}
