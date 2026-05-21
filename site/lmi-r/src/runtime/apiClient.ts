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

  return {
    status: () => getJson<StatusResponse>('/status')
  };
}
