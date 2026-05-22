import type { LmiPacket } from './lmi-packet';

export interface LmiCodec {
  contentType: string;
  encode(packet: LmiPacket): Uint8Array;
  decode(data: Uint8Array | ArrayBuffer): LmiPacket;
}

type MsgpackValue = null | boolean | number | string | MsgpackValue[] | { [key: string]: MsgpackValue };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const binaryLmiCodec: LmiCodec = {
  contentType: 'application/x-msgpack',
  encode: (packet) => encodeMsgpack(packet as unknown as MsgpackValue),
  decode: (data) => decodeMsgpack(data instanceof Uint8Array ? data : new Uint8Array(data)) as unknown as LmiPacket
};

export function encodeMsgpack(value: unknown): Uint8Array {
  const chunks: number[] = [];
  writeValue(chunks, value as MsgpackValue);
  return new Uint8Array(chunks);
}

export function decodeMsgpack(data: Uint8Array): unknown {
  const reader = { data, offset: 0 };
  return readValue(reader);
}

function writeValue(out: number[], value: MsgpackValue | undefined): void {
  if (value === undefined || value === null) {
    out.push(0xc0);
  } else if (typeof value === 'boolean') {
    out.push(value ? 0xc3 : 0xc2);
  } else if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 0x7f) out.push(value);
    else if (Number.isInteger(value) && value >= -32 && value < 0) out.push(0xe0 | (value + 32));
    else if (Number.isInteger(value) && value >= 0 && value <= 0xff) out.push(0xcc, value);
    else if (Number.isInteger(value) && value >= 0 && value <= 0xffff) writeU16(out, 0xcd, value);
    else if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) writeU32(out, value);
    else if (Number.isInteger(value) && Number.isSafeInteger(value)) writeI64(out, value);
    else if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) writeI32(out, value);
    else writeF64(out, value);
  } else if (typeof value === 'string') {
    writeString(out, value);
  } else if (Array.isArray(value)) {
    if (value.length < 16) out.push(0x90 | value.length);
    else writeU16(out, 0xdc, value.length);
    value.forEach((item) => writeValue(out, item));
  } else {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined) as [string, MsgpackValue][];
    if (entries.length < 16) out.push(0x80 | entries.length);
    else writeU16(out, 0xde, entries.length);
    for (const [key, item] of entries) {
      writeString(out, key);
      writeValue(out, item);
    }
  }
}

function writeString(out: number[], value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length < 32) out.push(0xa0 | bytes.length);
  else if (bytes.length <= 0xff) out.push(0xd9, bytes.length);
  else writeU16(out, 0xda, bytes.length);
  out.push(...bytes);
}

function writeU16(out: number[], marker: number, value: number): void {
  out.push(marker, (value >>> 8) & 0xff, value & 0xff);
}

function writeI32(out: number[], value: number): void {
  out.push(0xd2, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeU32(out: number[], value: number): void {
  out.push(0xce, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeI64(out: number[], value: number): void {
  let bigint = BigInt(value);
  if (bigint < 0) bigint = (1n << 64n) + bigint;
  out.push(0xd3);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out.push(Number((bigint >> shift) & 0xffn));
  }
}

function writeF64(out: number[], value: number): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  out.push(0xcb, ...bytes);
}

function readValue(reader: { data: Uint8Array; offset: number }): MsgpackValue {
  const marker = reader.data[reader.offset++];
  if (marker <= 0x7f) return marker;
  if (marker >= 0xe0) return marker - 0x100;
  if ((marker & 0xe0) === 0xa0) return readString(reader, marker & 0x1f);
  if ((marker & 0xf0) === 0x90) return readArray(reader, marker & 0x0f);
  if ((marker & 0xf0) === 0x80) return readMap(reader, marker & 0x0f);

  switch (marker) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xd0: return readI8(reader);
    case 0xd1: return readI16(reader);
    case 0xcc: return reader.data[reader.offset++];
    case 0xcd: return readU16(reader);
    case 0xce: return readU32(reader);
    case 0xcf: return readU64(reader);
    case 0xd2: return readI32(reader);
    case 0xd3: return readI64(reader);
    case 0xcb: return readF64(reader);
    case 0xd9: return readString(reader, reader.data[reader.offset++]);
    case 0xda: return readString(reader, readU16(reader));
    case 0xdc: return readArray(reader, readU16(reader));
    case 0xde: return readMap(reader, readU16(reader));
    default: throw new Error(`Unsupported LMI binary marker 0x${marker.toString(16)}`);
  }
}

function readString(reader: { data: Uint8Array; offset: number }, length: number): string {
  const value = decoder.decode(reader.data.slice(reader.offset, reader.offset + length));
  reader.offset += length;
  return value;
}

function readArray(reader: { data: Uint8Array; offset: number }, length: number): MsgpackValue[] {
  return Array.from({ length }, () => readValue(reader));
}

function readMap(reader: { data: Uint8Array; offset: number }, length: number): { [key: string]: MsgpackValue } {
  const value: { [key: string]: MsgpackValue } = {};
  for (let index = 0; index < length; index += 1) {
    const key = readValue(reader);
    if (typeof key !== 'string') throw new Error('LMI binary map keys must be strings');
    value[key] = readValue(reader);
  }
  return value;
}

function readU16(reader: { data: Uint8Array; offset: number }): number {
  const value = (reader.data[reader.offset] << 8) | reader.data[reader.offset + 1];
  reader.offset += 2;
  return value;
}

function readI8(reader: { data: Uint8Array; offset: number }): number {
  return (reader.data[reader.offset++] << 24) >> 24;
}

function readI16(reader: { data: Uint8Array; offset: number }): number {
  const value = (reader.data[reader.offset] << 8) | reader.data[reader.offset + 1];
  reader.offset += 2;
  return (value << 16) >> 16;
}

function readI32(reader: { data: Uint8Array; offset: number }): number {
  const view = new DataView(reader.data.buffer, reader.data.byteOffset + reader.offset, 4);
  const value = view.getInt32(0, false);
  reader.offset += 4;
  return value;
}

function readU32(reader: { data: Uint8Array; offset: number }): number {
  const view = new DataView(reader.data.buffer, reader.data.byteOffset + reader.offset, 4);
  const value = view.getUint32(0, false);
  reader.offset += 4;
  return value;
}

function readU64(reader: { data: Uint8Array; offset: number }): number {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(reader.data[reader.offset++]);
  }
  return Number(value);
}

function readI64(reader: { data: Uint8Array; offset: number }): number {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(reader.data[reader.offset++]);
  }
  if (value & (1n << 63n)) value -= 1n << 64n;
  return Number(value);
}

function readF64(reader: { data: Uint8Array; offset: number }): number {
  const view = new DataView(reader.data.buffer, reader.data.byteOffset + reader.offset, 8);
  const value = view.getFloat64(0, false);
  reader.offset += 8;
  return value;
}
