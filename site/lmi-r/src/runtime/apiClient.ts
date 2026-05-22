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
  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `API request failed: ${response.status}`);
    }
    return body as T;
  }

  async function postJson<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `API request failed: ${response.status}`);
    }
    return body as T;
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
    status: () => getJson<StatusResponse>('/status'),
    login: async (username, password) => {
      const response = await postJson<{ ok: boolean; user: LoginUser }>('/auth/login', { username, password });
      return response.user;
    },
    packet: (packet) => postBinary<LmiPacket>('/packet', packet),
    packetBatch: (packets) => postBinary<LmiPacket[]>('/packet/batch', packets)
  };
}
