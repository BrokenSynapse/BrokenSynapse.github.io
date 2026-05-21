import type { LmiPacket } from './lmi-packet';

export interface LmiCodec {
  contentType: string;
  encode(packet: LmiPacket): Uint8Array | string;
  decode(data: Uint8Array | string): LmiPacket;
}

export const jsonLmiCodec: LmiCodec = {
  contentType: 'application/json',
  encode: (packet) => JSON.stringify(packet),
  decode: (data) => JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as LmiPacket
};

// TODO: add MessagePack/CBOR codecs once the packet shape settles.
