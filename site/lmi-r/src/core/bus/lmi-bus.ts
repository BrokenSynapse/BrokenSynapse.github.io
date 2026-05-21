import type { ApiClient } from '../../runtime/apiClient';
import type { ModuleDefinition, ModuleRegistry } from '../../runtime/moduleRegistry';
import { hasCapability, type LmiCapability } from './lmi-capabilities';
import { jsonLmiCodec, type LmiCodec } from './lmi-codec';
import { LmiOp } from './lmi-opcodes';
import { createPacket, type LmiPacket } from './lmi-packet';
import { LmiRouter } from './lmi-router';
import { LmiStore } from './lmi-store';
import type { BusDebugView, LmiAddress, LmiScope } from './lmi-types';

export class LmiBus {
  private readonly router = new LmiRouter();
  private readonly store = new LmiStore();
  private readonly recentPackets: LmiPacket[] = [];
  private readonly pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private readonly modules = new Map<string, ModuleDefinition>();

  constructor(
    private readonly api: ApiClient,
    private readonly registry: ModuleRegistry,
    private readonly codec: LmiCodec = jsonLmiCodec
  ) {
    for (const module of registry.list()) {
      this.registerModule(module);
    }
  }

  registerModule(module: ModuleDefinition): void {
    this.modules.set(module.id, module);
    this.record(createPacket({
      op: LmiOp.MODULE_REGISTER,
      source: this.shellAddress(),
      target: { kind: 'module', id: module.id },
      scope: 'session',
      payload: { name: module.name, capabilities: module.capabilities }
    }));
  }

  moduleCapabilities(moduleId: string): string[] {
    return this.modules.get(moduleId)?.capabilities ?? [];
  }

  require(moduleId: string, capability: LmiCapability): void {
    if (!hasCapability(this.moduleCapabilities(moduleId), capability)) {
      throw new Error(`${moduleId} lacks capability ${capability}`);
    }
  }

  async send(packet: LmiPacket): Promise<unknown> {
    this.record(packet);

    if (packet.scope === 'server' || packet.target?.kind === 'server') {
      return this.api.packet(packet);
    }

    if (packet.op === LmiOp.MSG_REQUEST && packet.payload && typeof packet.payload === 'object') {
      const request = packet.payload as { type?: string };
      if (request.type === 'debug.bus') return this.debug();
    }

    if (packet.op === LmiOp.APP_ACTION && packet.payload && typeof packet.payload === 'object') {
      const action = packet.payload as { action?: string };
      if (action.action === 'debug.bus') return this.debug();
    }

    if (packet.target?.kind === 'module') {
      return this.router.sendToModule(packet.target.id, packet);
    }

    return undefined;
  }

  publish(topic: string, packet: LmiPacket): void {
    this.record(packet);
    this.router.publish(topic, packet);
  }

  subscribe(topic: string, handler: (packet: LmiPacket) => void): () => void {
    return this.router.subscribe(topic, handler);
  }

  async getState<T>(key: string, moduleId: string, scope: LmiScope = 'user'): Promise<T | undefined> {
    this.require(moduleId, 'state:read');
    const local = this.store.get<T>(key);
    if (local !== undefined) return local;

    const packet = createPacket({
      op: LmiOp.STATE_GET,
      source: this.moduleAddress(moduleId),
      target: { kind: 'server', id: 'api-r' },
      scope: 'server',
      payload: { key, scope }
    });
    const response = await this.api.packet(packet);
    const value = (response.payload as { value?: T } | undefined)?.value;
    if (value !== undefined) this.store.set(key, value, response);
    this.record(packet);
    this.record(response);
    return value;
  }

  async setState<T>(key: string, value: T, moduleId: string, options: { persist?: boolean; scope?: LmiScope } = {}): Promise<void> {
    this.require(moduleId, 'state:write');
    const scope = options.scope ?? 'user';
    const packet = createPacket({
      op: LmiOp.STATE_SET,
      source: this.moduleAddress(moduleId),
      target: options.persist ? { kind: 'server', id: 'api-r' } : this.shellAddress(),
      scope: options.persist ? 'server' : scope,
      payload: { key, value, scope }
    });
    this.store.set(key, value, packet);
    this.record(packet);
    if (options.persist) {
      const response = await this.api.packet(packet);
      this.record(response);
    }
  }

  async patchState<T extends object>(key: string, patch: Partial<T>, moduleId: string, options: { persist?: boolean; scope?: LmiScope } = {}): Promise<void> {
    this.require(moduleId, 'state:write');
    const value = this.store.patch<T>(key, patch, createPacket({
      op: LmiOp.STATE_PATCH,
      source: this.moduleAddress(moduleId),
      scope: options.scope ?? 'user',
      payload: { key, patch }
    }));
    await this.setState(key, value, moduleId, options);
  }

  openApp(appId: string, moduleId: string, args?: unknown): Promise<void> {
    this.require(moduleId, 'app:open');
    return this.send(createPacket({
      op: LmiOp.APP_OPEN,
      source: this.moduleAddress(moduleId),
      target: { kind: 'shell', id: 'runtime' },
      scope: 'session',
      payload: { appId, args }
    })).then(() => undefined);
  }

  debug(): BusDebugView {
    return {
      registeredModules: [...this.modules.values()].map((module) => ({
        id: module.id,
        name: module.name,
        capabilities: module.capabilities
      })),
      recentPackets: this.recentPackets.slice(-20).map(({ id, op, source, target, scope, ts, payload }) => ({ id, op, source, target, scope, ts, payload })),
      knownTopics: this.router.topics(),
      pendingRequestCount: this.pendingRequests.size,
      stateKeys: this.store.keys()
    };
  }

  encode(packet: LmiPacket): Uint8Array | string {
    return this.codec.encode(packet);
  }

  private record(packet: LmiPacket): void {
    this.recentPackets.push(packet);
    if (this.recentPackets.length > 100) this.recentPackets.shift();
  }

  private shellAddress(): LmiAddress {
    return { kind: 'shell', id: 'runtime' };
  }

  private moduleAddress(moduleId: string): LmiAddress {
    return { kind: 'module', id: moduleId };
  }
}
