export type WireType = 0 | 2;

type ProtoField = {
  wireType: WireType;
  value: bigint | Uint8Array;
};

type ProtoMessage = Map<number, ProtoField[]>;

const WIRE_VARINT: WireType = 0;
const WIRE_LEN: WireType = 2;
const STATUS_SUCCESS = 0;

function assertVarintInput(value: number | bigint): bigint {
  const normalized = typeof value === "number" ? BigInt(value) : value;
  if (normalized < 0n) {
    throw new Error("Varint cannot be negative");
  }
  return normalized;
}

function encodeVarint(value: number | bigint): Uint8Array {
  let v = assertVarintInput(value);
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Uint8Array.from(bytes);
}

function decodeVarint(payload: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < payload.length) {
    const byte = payload[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error("Malformed varint");
    }
  }
  throw new Error("Truncated varint");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeTag(fieldNumber: number, wireType: WireType): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
}

function encodeBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes([encodeTag(fieldNumber, WIRE_LEN), encodeVarint(value.length), value]);
}

function decodeMessage(payload: Uint8Array): ProtoMessage {
  const message: ProtoMessage = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const tag = decodeVarint(payload, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n) as WireType;
    if (fieldNumber <= 0) {
      throw new Error("Malformed protobuf tag");
    }

    if (wireType === WIRE_VARINT) {
      const decoded = decodeVarint(payload, offset);
      offset = decoded.offset;
      const list = message.get(fieldNumber) ?? [];
      list.push({ wireType, value: decoded.value });
      message.set(fieldNumber, list);
      continue;
    }

    if (wireType === WIRE_LEN) {
      const lengthDecoded = decodeVarint(payload, offset);
      offset = lengthDecoded.offset;
      const length = Number(lengthDecoded.value);
      if (!Number.isFinite(length) || length < 0) {
        throw new Error("Malformed length-delimited protobuf field");
      }
      const end = offset + length;
      if (end > payload.length) {
        throw new Error("Truncated length-delimited protobuf field");
      }
      const value = payload.slice(offset, end);
      offset = end;
      const list = message.get(fieldNumber) ?? [];
      list.push({ wireType, value });
      message.set(fieldNumber, list);
      continue;
    }

    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
  return message;
}

function getVarintField(message: ProtoMessage, fieldNumber: number, index = 0): bigint | undefined {
  const field = message.get(fieldNumber)?.[index];
  if (!field || field.wireType !== WIRE_VARINT) {
    return undefined;
  }
  return field.value as bigint;
}

function getBytesField(message: ProtoMessage, fieldNumber: number, index = 0): Uint8Array | undefined {
  const field = message.get(fieldNumber)?.[index];
  if (!field || field.wireType !== WIRE_LEN) {
    return undefined;
  }
  return field.value as Uint8Array;
}

function toNumber(value: bigint | undefined, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return fallback;
  }
  return asNumber;
}

function toSignedInt32(value: bigint | undefined, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }
  const lower = Number(value & 0xffffffffn);
  return lower >= 0x80000000 ? lower - 0x100000000 : lower;
}

function decodeBool(value: bigint | undefined): boolean {
  return value !== undefined && value !== 0n;
}

function encodeSessionData(sec1Payload: Uint8Array): Uint8Array {
  return concatBytes([
    encodeVarintField(2, 1),
    encodeBytesField(11, sec1Payload),
  ]);
}

function decodeSessionData(payload: Uint8Array): ProtoMessage {
  const root = decodeMessage(payload);
  const secVer = toNumber(getVarintField(root, 2));
  if (secVer !== 1) {
    throw new Error(`Unsupported security version: ${secVer}`);
  }
  const sec1Payload = getBytesField(root, 11);
  if (!sec1Payload) {
    throw new Error("Missing sec1 session payload");
  }
  return decodeMessage(sec1Payload);
}

function textDecode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\u0000+$/g, "");
}

export interface WiFiScanEntry {
  ssid: string;
  bssidHex: string;
  channel: number;
  rssi: number;
  auth: number;
}

export interface WiFiStatus {
  status: number;
  staState: number;
  failReason?: number;
  attemptsRemaining?: number;
}

export function encodeSessionCommand0(clientPublicKey: Uint8Array): Uint8Array {
  const cmd0 = encodeBytesField(1, clientPublicKey);
  const sec1 = concatBytes([
    encodeVarintField(1, 0),
    encodeBytesField(20, cmd0),
  ]);
  return encodeSessionData(sec1);
}

export function decodeSessionResponse0(payload: Uint8Array): {
  status: number;
  devicePublicKey: Uint8Array;
  deviceRandom: Uint8Array;
} {
  const sec1 = decodeSessionData(payload);
  const msg = toNumber(getVarintField(sec1, 1), -1);
  if (msg !== 1) {
    throw new Error(`Unexpected sec1 message type: ${msg}`);
  }
  const sr0Bytes = getBytesField(sec1, 21);
  if (!sr0Bytes) {
    throw new Error("Missing SessionResp0 payload");
  }
  const sr0 = decodeMessage(sr0Bytes);
  const status = toNumber(getVarintField(sr0, 1), -1);
  const devicePublicKey = getBytesField(sr0, 2) ?? new Uint8Array();
  const deviceRandom = getBytesField(sr0, 3) ?? new Uint8Array();
  if (devicePublicKey.length !== 32 || deviceRandom.length !== 16) {
    throw new Error("Invalid SessionResp0 payload lengths");
  }
  return { status, devicePublicKey, deviceRandom };
}

export function encodeSessionCommand1(clientVerifyData: Uint8Array): Uint8Array {
  const cmd1 = encodeBytesField(2, clientVerifyData);
  const sec1 = concatBytes([
    encodeVarintField(1, 2),
    encodeBytesField(22, cmd1),
  ]);
  return encodeSessionData(sec1);
}

export function decodeSessionResponse1(payload: Uint8Array): {
  status: number;
  deviceVerifyData: Uint8Array;
} {
  const sec1 = decodeSessionData(payload);
  const msg = toNumber(getVarintField(sec1, 1), -1);
  if (msg !== 3) {
    throw new Error(`Unexpected sec1 message type: ${msg}`);
  }
  const sr1Bytes = getBytesField(sec1, 23);
  if (!sr1Bytes) {
    throw new Error("Missing SessionResp1 payload");
  }
  const sr1 = decodeMessage(sr1Bytes);
  return {
    status: toNumber(getVarintField(sr1, 1), -1),
    deviceVerifyData: getBytesField(sr1, 3) ?? new Uint8Array(),
  };
}

export function encodeWiFiScanStart(groupChannels = 0, periodMs = 120): Uint8Array {
  const cmd = concatBytes([
    encodeVarintField(1, 1),
    encodeVarintField(2, 0),
    encodeVarintField(3, groupChannels),
    encodeVarintField(4, periodMs),
  ]);
  return concatBytes([
    encodeVarintField(1, 0),
    encodeBytesField(10, cmd),
  ]);
}

export function decodeWiFiScanStartResponse(payload: Uint8Array): number {
  const msg = decodeMessage(payload);
  return toNumber(getVarintField(msg, 2), STATUS_SUCCESS);
}

export function encodeWiFiScanStatusRequest(): Uint8Array {
  return concatBytes([
    encodeVarintField(1, 2),
    encodeBytesField(12, new Uint8Array()),
  ]);
}

export function decodeWiFiScanStatusResponse(payload: Uint8Array): {
  status: number;
  finished: boolean;
  resultCount: number;
} {
  const message = decodeMessage(payload);
  const status = toNumber(getVarintField(message, 2), STATUS_SUCCESS);
  const body = decodeMessage(getBytesField(message, 13) ?? new Uint8Array());
  return {
    status,
    finished: decodeBool(getVarintField(body, 1)),
    resultCount: toNumber(getVarintField(body, 2)),
  };
}

export function encodeWiFiScanResultRequest(startIndex: number, count: number): Uint8Array {
  const cmd = concatBytes([
    encodeVarintField(1, startIndex),
    encodeVarintField(2, count),
  ]);
  return concatBytes([
    encodeVarintField(1, 4),
    encodeBytesField(14, cmd),
  ]);
}

export function decodeWiFiScanResultResponse(payload: Uint8Array): {
  status: number;
  entries: WiFiScanEntry[];
} {
  const message = decodeMessage(payload);
  const status = toNumber(getVarintField(message, 2), STATUS_SUCCESS);
  const body = decodeMessage(getBytesField(message, 15) ?? new Uint8Array());
  const entryFields = body.get(1) ?? [];
  const entries: WiFiScanEntry[] = [];

  for (const field of entryFields) {
    if (field.wireType !== WIRE_LEN) {
      continue;
    }
    const entry = decodeMessage(field.value as Uint8Array);
    const ssidRaw = getBytesField(entry, 1) ?? new Uint8Array();
    const bssidRaw = getBytesField(entry, 4) ?? new Uint8Array();
    entries.push({
      ssid: textDecode(ssidRaw),
      bssidHex: Array.from(bssidRaw)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
      channel: toNumber(getVarintField(entry, 2)),
      rssi: toSignedInt32(getVarintField(entry, 3)),
      auth: toNumber(getVarintField(entry, 5)),
    });
  }
  return { status, entries };
}

export function encodeWiFiConfigSet(ssid: string, passphrase: string): Uint8Array {
  const cmd = concatBytes([
    encodeBytesField(1, new TextEncoder().encode(ssid)),
    encodeBytesField(2, new TextEncoder().encode(passphrase)),
  ]);
  return concatBytes([
    encodeVarintField(1, 2),
    encodeBytesField(12, cmd),
  ]);
}

export function decodeWiFiConfigSetResponse(payload: Uint8Array): number {
  const message = decodeMessage(payload);
  const body = decodeMessage(getBytesField(message, 13) ?? new Uint8Array());
  return toNumber(getVarintField(body, 1), STATUS_SUCCESS);
}

export function encodeWiFiConfigApply(): Uint8Array {
  return concatBytes([
    encodeVarintField(1, 4),
    encodeBytesField(14, new Uint8Array()),
  ]);
}

export function decodeWiFiConfigApplyResponse(payload: Uint8Array): number {
  const message = decodeMessage(payload);
  const body = decodeMessage(getBytesField(message, 15) ?? new Uint8Array());
  return toNumber(getVarintField(body, 1), STATUS_SUCCESS);
}

export function encodeWiFiConfigGetStatus(): Uint8Array {
  return concatBytes([
    encodeVarintField(1, 0),
    encodeBytesField(10, new Uint8Array()),
  ]);
}

export function decodeWiFiConfigGetStatusResponse(payload: Uint8Array): WiFiStatus {
  const message = decodeMessage(payload);
  const body = decodeMessage(getBytesField(message, 11) ?? new Uint8Array());
  const statePayloadAttempt = getBytesField(body, 12);
  const attemptMessage = statePayloadAttempt ? decodeMessage(statePayloadAttempt) : undefined;
  return {
    status: toNumber(getVarintField(body, 1), STATUS_SUCCESS),
    staState: toNumber(getVarintField(body, 2), 2),
    failReason: toNumber(getVarintField(body, 10), -1),
    attemptsRemaining: attemptMessage ? toNumber(getVarintField(attemptMessage, 1), -1) : undefined,
  };
}
