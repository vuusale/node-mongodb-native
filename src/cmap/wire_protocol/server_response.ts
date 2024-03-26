import {
  type Binary,
  BSON,
  BSONType,
  type Document,
  Long,
  type ObjectId,
  type Timestamp
} from '../../bson';
import { LEGACY_HELLO_COMMAND } from '../../constants';
import { type ErrorDescription } from '../../error';
import { type ClusterTime } from '../../sdam/common';
import { type TagSet, type TopologyVersion } from '../../sdam/server_description';
import { decompress } from './compression';
import { OP_COMPRESSED, OP_REPLY } from './constants';
import { OnDemandDocument } from './on_demand_document';

const handler: ProxyHandler<MongoDBResponse> = {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) {
      return Reflect.get(target, property, receiver);
    }
    throw new Error('access ' + String(property) + ' on serverResponse');
  }
};

// eslint-disable-next-line @typescript-eslint/unbound-method
const getInt32LE = BSON.onDemand.NumberUtils.getInt32LE;

const OPTS_CHECKSUM_PRESENT = 1;
const OPTS_MORE_TO_COME = 2;
const OPTS_EXHAUST_ALLOWED = 1 << 16;

/** @internal */
export class MongoDBResponse extends OnDemandDocument {
  private fullBSON?: Document;

  private constructor(
    public requestId: number,
    public responseTo: number,
    public checksumPresent: boolean,
    public moreToCome: boolean,
    public exhaustAllowed: boolean,
    bson: Uint8Array
  ) {
    super(bson);
  }

  private static opReply(offset: number, message: Uint8Array): Uint8Array {
    offset += 4; // op_reply flags
    offset += 8; // cursor id
    offset += 4; // startingFrom
    offset += 4; // numberReturned
    return message.subarray(offset);
  }

  public static async create(message: Uint8Array) {
    let offset = 0;

    let length = getInt32LE(message, offset);
    offset += 4;

    const requestId = getInt32LE(message, offset);
    offset += 4;

    const responseTo = getInt32LE(message, offset);
    offset += 4;

    let opCode = getInt32LE(message, offset);
    offset += 4;

    let body = message;

    if (opCode === OP_COMPRESSED) {
      opCode = getInt32LE(message, offset);
      offset += 4;

      length = getInt32LE(message, offset);
      offset += 4;

      const compressorId = message[offset];
      offset += 1;

      const compressedBuffer = message.subarray(offset, offset + length);
      // @ts-expect-error: compression needs to be more permissive of byte arrays
      body = await decompress(compressorId, compressedBuffer);
    }

    if (opCode === OP_REPLY) {
      return new Proxy(
        new this(
          requestId,
          responseTo,
          false,
          false,
          false,
          MongoDBResponse.opReply(offset, message)
        ),
        handler
      );
    }

    const flagBits = getInt32LE(body, offset);
    offset += 4;

    const checksumPresent = (flagBits & OPTS_CHECKSUM_PRESENT) !== 0;
    const moreToCome = (flagBits & OPTS_MORE_TO_COME) !== 0;
    const exhaustAllowed = (flagBits & OPTS_EXHAUST_ALLOWED) !== 0;

    const payloadType = body[offset];
    offset += 1;

    if (payloadType !== 0) {
      throw new Error('unsupported payload type');
    }

    const bsonDocumentSize = getInt32LE(body, offset);
    const bson = body.subarray(offset, offset + bsonDocumentSize);

    return new Proxy(
      new this(requestId, responseTo, checksumPresent, moreToCome, exhaustAllowed, bson),
      handler
    );
  }

  then = null; // temp

  public getFullBSON(freshCopy = false) {
    // if (freshCopy) return BSON.deserialize(this.bson);
    // if (!('fullBSON' in this)) this.fullBSON ??= BSON.deserialize(this.bson);
    return BSON.deserialize(this.bson);
  }

  public get isError() {
    let isError = this.ok === 0;
    isError ||= this.hasElement('$err');
    isError ||= this.hasElement('errmsg');
    isError ||= this.hasElement('code');
    return isError;
  }

  public get errorCode(): number {
    return this.getFlexibleNumber('code') ?? 0;
  }

  public get errorLabels(): string[] {
    return this.getValue('errorLabels', BSONType.array)?.toArray() ?? [];
  }

  public get errorMessage(): string {
    return (
      this.getValue('message', BSONType.string) ??
      this.getValue('$err', BSONType.string) ??
      this.getValue('errmsg', BSONType.string) ??
      'n/a'
    );
  }

  private clusterTime?: ClusterTime | null;
  public get $clusterTime(): ClusterTime | null {
    if (!('clusterTime' in this)) {
      const clusterTimeDoc = this.getValue('$clusterTime', BSONType.object);
      if (clusterTimeDoc == null) {
        this.clusterTime = null;
        return null;
      }
      const clusterTime = clusterTimeDoc.getValue('clusterTime', BSONType.timestamp, true);
      const signatureDoc = clusterTimeDoc.getValue('signature', BSONType.object, true);
      const hash = signatureDoc.getValue('hash', BSONType.binData, true);
      const keyId = Long.fromBigInt(signatureDoc.getValue('keyId', BSONType.long, true));
      this.clusterTime = { clusterTime, signature: { hash, keyId } };
    }
    return this.clusterTime ?? null;
  }

  public get ok(): 1 | 0 {
    return this.getFlexibleNumber('ok', true) ? 1 : 0;
  }

  public get operationTime(): Timestamp | null {
    return this.getValue('operationTime', BSONType.timestamp);
  }

  private _atClusterTime?: Timestamp | null;
  public get atClusterTime(): Timestamp | null {
    if (!('_atClusterTime' in this)) {
      // Check the cursor first for 'atClusterTime', fall back to top-level
      this._atClusterTime =
        this.getValue('cursor', BSONType.object)?.getValue('atClusterTime', BSONType.timestamp) ??
        this.getValue('atClusterTime', BSONType.timestamp);
    }
    return this._atClusterTime ?? null;
  }

  public get writeConcernError(): ErrorDescription | null {
    if (!this.hasElement('writeConcernError')) return null;
    const writeConcernError = this.getValue('writeConcernError', BSONType.object);
    if (writeConcernError == null) return null;
    return writeConcernError.toObject();
  }

  public get helloOk(): boolean {
    return Boolean(this.getValue('helloOk', BSONType.bool));
  }

  public get maxWireVersion(): number {
    return this.getFlexibleNumber('maxWireVersion') ?? 0;
  }

  public get minWireVersion(): number {
    return this.getFlexibleNumber('minWireVersion') ?? 0;
  }

  public get serviceId(): ObjectId | null {
    return this.getValue('serviceId', BSONType.objectId);
  }

  public get arbiterOnly(): boolean {
    return this.getValue('arbiterOnly', BSONType.bool) ?? false;
  }

  // This is problematic
  public get recoveryToken(): Document | null {
    return null;
  }

  public get connectionId(): bigint | null {
    return this.getValue('connectionId', BSONType.long);
  }

  public get speculativeAuthenticate() {
    return this.getValue('speculativeAuthenticate', BSONType.object)?.toObject();
  }

  public get saslSupportedMechs() {
    return this.getValue('saslSupportedMechs', BSONType.array)?.toArray();
  }

  // GSSAPI expects string, AWS and SCRAM expect Binary. I have my doubts about the GSSAPI expectation
  public get payload(): never {
    throw new Error('specify what type you would like back pls!');
  }
  public get payloadAsString(): string {
    return this.getValue('payload', BSONType.string, true);
  }
  public get payloadAsBinary(): Binary {
    return this.getValue('payload', BSONType.binData, true);
  }

  public get nonce(): number {
    throw new Error('getnonce!!!');
  }

  public get conversationId(): number {
    return this.getFlexibleNumber('conversationId', true);
  }

  // Optionally exists, if does not exist, return false
  public get done(): boolean {
    return this.getValue('done', BSONType.bool) ?? false;
  }

  /** Optional property, if exists and true indicates RSGhost */
  public get isreplicaset(): boolean {
    return this.getValue('isreplicaset', BSONType.bool) ?? false;
  }

  /** Optional property, if exists and 'isdbgrid' indicates MongoS */
  public get msg(): string | null {
    return this.getValue('msg', BSONType.string);
  }

  /** Optional property */
  public get setName(): string | null {
    return this.getValue('setName', BSONType.string);
  }

  /** Optional property */
  public get hidden(): boolean {
    return this.getValue('hidden', BSONType.bool) ?? false;
  }

  /** Optional property */
  public get isWritablePrimary(): boolean {
    return (
      this.getValue('isWritablePrimary', BSONType.bool) ??
      this.getValue(LEGACY_HELLO_COMMAND, BSONType.bool) ??
      false
    );
  }

  /** Optional property */
  public get secondary(): boolean {
    return this.getValue('secondary', BSONType.bool) ?? false;
  }

  /** Optional property */
  public get hosts(): string[] {
    // toArray cheating for now:
    return this.getValue('hosts', BSONType.array)?.toArray() ?? [];
  }

  /** Optional property */
  public get passives(): string[] {
    // toArray cheating for now:
    return this.getValue('passives', BSONType.array)?.toArray() ?? [];
  }

  /** Optional property */
  public get arbiters(): string[] {
    // toArray cheating for now:
    return this.getValue('arbiters', BSONType.array)?.toArray() ?? [];
  }

  /** Optional property */
  public get tags(): TagSet {
    // toObject cheating for now:
    return this.getValue('tags', BSONType.object)?.toObject() ?? {};
  }

  /**
   * lastWrite is a top-level key, we want the embedded doc's lastWriteDate element
   * ```js
   * lastWrite: { lastWriteDate }
   * ```
   */
  public get ['lastWrite.lastWriteDate'](): Date | null {
    return (
      this.getValue('lastWrite', BSONType.object)?.getValue('lastWriteDate', BSONType.date) ?? null
    );
  }

  private _topologyVersion?: TopologyVersion | null;
  public get topologyVersion(): TopologyVersion | null {
    if (!('_topologyVersion' in this)) {
      const topologyVersion = this.getValue('topologyVersion', BSONType.object);
      if (topologyVersion == null) {
        this._topologyVersion = null;
        return null;
      }

      const processId = topologyVersion.getValue('processId', BSONType.objectId, true);
      const counter = Long.fromBigInt(topologyVersion.getValue('counter', BSONType.long, true));
      this._topologyVersion = { processId, counter };
    }
    return this._topologyVersion ?? null;
  }

  /** Optional property */
  public get setVersion(): number | null {
    return this.getFlexibleNumber('setVersion');
  }

  /** Optional property */
  public get electionId(): ObjectId | null {
    return this.getValue('electionId', BSONType.objectId);
  }

  /** Optional property */
  public get logicalSessionTimeoutMinutes(): number | null {
    return this.getFlexibleNumber('logicalSessionTimeoutMinutes');
  }

  /** Optional property */
  public get primary(): string | null {
    return this.getValue('primary', BSONType.string);
  }

  /** Optional property */
  public get me(): string | null {
    return this.getValue('me', BSONType.string);
  }

  public get maxBsonObjectSize(): number {
    return this.getFlexibleNumber('maxBsonObjectSize') ?? 0;
  }
  public get maxMessageSizeBytes(): number {
    return this.getFlexibleNumber('maxMessageSizeBytes') ?? 0;
  }
  public get maxWriteBatchSize(): number {
    return this.getFlexibleNumber('maxWriteBatchSize') ?? 0;
  }
  public get compression(): string[] {
    return this.getValue('compression', BSONType.array)?.toArray() ?? [];
  }

  /** CreateSearchIndexesOperation: returns `{indexesCreated: {name:string}[]}` */
  public get indexesCreated(): string[] {
    return [];
  }
}
