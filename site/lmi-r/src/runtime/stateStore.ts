export interface StateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export function createStateStore(): StateStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      values.set(key, value);
    }
  };
}
