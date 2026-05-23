import type { LmiPacket } from '../core/bus/lmi-packet';
import { decodeMsgpack, encodeMsgpack } from '../core/bus/lmi-codec';

export interface StatusResponse {
  ok: boolean;
  service: string;
  version: string;
  api_prefix: string;
  database: string;
  started_at: number;
  now: number;
}

export interface LoginUser {
  username: string;
  cid: string;
  display_name: string;
  is_admin: boolean;
  home_path: string;
  shell: string;
}

export interface ApiClient {
  status(): Promise<StatusResponse>;
  login(username: string, password: string): Promise<LoginUser>;
  packet(packet: LmiPacket): Promise<LmiPacket>;
  packetBatch(packets: LmiPacket[]): Promise<LmiPacket[]>;
}

export function createApiClient(baseUrl: string): ApiClient {
  async function getBinary<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/x-msgpack' },
      cache: 'no-store'
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`Binary API request failed: ${response.status}`);
    }
    return decodeMsgpack(bytes) as T;
  }

  async function postBinary<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/x-msgpack', 'Content-Type': 'application/x-msgpack' },
      body: encodeMsgpack(payload) as BodyInit,
      cache: 'no-store'
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`Binary API request failed: ${response.status}`);
    }
    return decodeMsgpack(bytes) as T;
  }

  return {
    status: () => getBinary<StatusResponse>('/status.bin'),
    login: async (username, password) => {
      const response = await postBinary<{ ok: boolean; user: LoginUser }>('/auth/login.bin', { username, password });
      return response.user;
    },
    packet: (packet) => postBinary<LmiPacket>('/packet', packet),
    packetBatch: (packets) => postBinary<LmiPacket[]>('/packet/batch', packets)
  };
}
