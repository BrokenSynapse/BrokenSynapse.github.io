import type { LmiPacket } from './lmi-packet';

export class LmiStore {
  private readonly values = new Map<string, unknown>();
  private readonly subscribers = new Map<string, Set<(value: unknown, packet: LmiPacket) => void>>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  keys(): string[] {
    return [...this.values.keys()].sort();
  }

  set<T>(key: string, value: T, packet: LmiPacket): void {
    this.values.set(key, value);
    this.subscribers.get(key)?.forEach((handler) => handler(value, packet));
  }

  patch<T extends object>(key: string, patch: Partial<T>, packet: LmiPacket): T {
    const existing = (this.values.get(key) ?? {}) as T;
    const next = Object.assign({}, existing, patch);
    this.set(key, next, packet);
    return next;
  }

  delete(key: string, packet: LmiPacket): void {
    this.values.delete(key);
    this.subscribers.get(key)?.forEach((handler) => handler(undefined, packet));
  }

  subscribe(key: string, handler: (value: unknown, packet: LmiPacket) => void): () => void {
    const handlers = this.subscribers.get(key) ?? new Set();
    handlers.add(handler);
    this.subscribers.set(key, handlers);
    return () => handlers.delete(handler);
  }
}
