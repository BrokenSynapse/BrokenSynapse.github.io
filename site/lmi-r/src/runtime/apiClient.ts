import type { LmiPacket } from '../core/bus/lmi-packet';

export interface StatusResponse {
  ok: boolean;
  service: string;
  version: string;
  api_prefix: string;
  database: string;
  started_at: number;
  now: number;
}

export interface ApiClient {
  status(): Promise<StatusResponse>;
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

  return {
    status: () => getJson<StatusResponse>('/status'),
    packet: (packet) => postJson<LmiPacket>('/packet', packet),
    packetBatch: (packets) => postJson<LmiPacket[]>('/packet/batch', packets)
  };
}
