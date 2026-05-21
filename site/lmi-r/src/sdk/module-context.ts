import { LmiOp } from '../core/bus/lmi-opcodes';
import { createPacket, type LmiPacket } from '../core/bus/lmi-packet';
import type { EntityQuery, LmiAssetRef, LmiScope } from '../core/bus/lmi-types';
import type { LmiBus } from '../core/bus/lmi-bus';

export type ModuleContext = {
  moduleId: string;
  send(target: string, type: string, payload?: unknown): Promise<void>;
  request<TResponse = unknown>(target: string, type: string, payload?: unknown): Promise<TResponse>;
  publish(topic: string, payload?: unknown): void;
  subscribe<TPayload = unknown>(topic: string, handler: (payload: TPayload, packet: LmiPacket) => void): () => void;
  getState<T = unknown>(key: string): Promise<T | undefined>;
  setState<T = unknown>(key: string, value: T, options?: { persist?: boolean; scope?: LmiScope }): Promise<void>;
  patchState<T = unknown>(key: string, patch: Partial<T>, options?: { persist?: boolean; scope?: LmiScope }): Promise<void>;
  getEntity<T = unknown>(id: string): Promise<T | undefined>;
  listEntities<T = unknown>(query?: EntityQuery): Promise<T[]>;
  createEntity<T = unknown>(kind: string, payload: T): Promise<string>;
  updateEntity<T = unknown>(id: string, payload: Partial<T>): Promise<void>;
  getAsset(ref: string): Promise<LmiAssetRef | undefined>;
  putAsset(fileOrBlob: File | Blob, meta?: Record<string, unknown>): Promise<LmiAssetRef>;
  openApp(appId: string, args?: unknown): Promise<void>;
  callAction(action: string, payload?: unknown): Promise<unknown>;
  log(message: string, data?: unknown): void;
};

export function createModuleContext(moduleId: string, bus: LmiBus): ModuleContext {
  const source = { kind: 'module' as const, id: moduleId };

  return {
    moduleId,
    send: async (target, type, payload) => {
      await bus.send(createPacket({
        op: LmiOp.MSG_SEND,
        source,
        target: { kind: 'module', id: target },
        scope: 'session',
        payload: { type, payload }
      }));
    },
    request: async <TResponse>(target: string, type: string, payload?: unknown) => {
      const response = await bus.send(createPacket({
        op: LmiOp.MSG_REQUEST,
        source,
        target: target === 'shell' ? { kind: 'shell', id: 'runtime' } : { kind: 'module', id: target },
        scope: 'session',
        payload: { type, payload }
      }));
      return response as TResponse;
    },
    publish: (topic, payload) => {
      bus.require(moduleId, 'event:publish');
      bus.publish(topic, createPacket({
        op: LmiOp.EVENT_PUBLISH,
        source,
        scope: 'broadcast',
        payload: { topic, payload }
      }));
    },
    subscribe: (topic, handler) => {
      bus.require(moduleId, 'event:subscribe');
      return bus.subscribe(topic, (packet) => {
        const payload = packet.payload as { payload?: unknown } | undefined;
        handler(payload?.payload as never, packet);
      });
    },
    getState: (key) => bus.getState(key, moduleId),
    setState: (key, value, options) => bus.setState(key, value, moduleId, options),
    patchState: (key, patch, options) => bus.patchState(key, patch as Partial<object>, moduleId, options),
    getEntity: async () => undefined,
    listEntities: async () => [],
    createEntity: async () => {
      bus.require(moduleId, 'entity:write');
      throw new Error('Entity create is reserved for the next LMI-R slice.');
    },
    updateEntity: async () => {
      bus.require(moduleId, 'entity:write');
      throw new Error('Entity update is reserved for the next LMI-R slice.');
    },
    getAsset: async (ref) => ({ ref, kind: 'asset', id: ref }),
    putAsset: async (fileOrBlob, meta) => {
      bus.require(moduleId, 'asset:write');
      return {
        ref: `local:${crypto.randomUUID()}`,
        kind: 'asset',
        id: crypto.randomUUID(),
        mime: fileOrBlob.type || String(meta?.mime || ''),
        size: fileOrBlob.size
      };
    },
    openApp: (appId, args) => bus.openApp(appId, moduleId, args),
    callAction: (action, payload) => bus.send(createPacket({
      op: LmiOp.APP_ACTION,
      source,
      target: { kind: 'shell', id: 'runtime' },
      scope: 'session',
      payload: { action, payload }
    })),
    log: (message, data) => {
      void bus.send(createPacket({
        op: LmiOp.DEBUG_PING,
        source,
        target: { kind: 'shell', id: 'runtime' },
        scope: 'local',
        payload: { message, data }
      }));
    }
  };
}
