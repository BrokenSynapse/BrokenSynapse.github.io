import type { LmiPacket } from './lmi-packet';

type PacketHandler = (packet: LmiPacket) => void | Promise<unknown>;

export class LmiRouter {
  private readonly moduleHandlers = new Map<string, PacketHandler>();
  private readonly topicHandlers = new Map<string, Set<PacketHandler>>();

  registerModule(moduleId: string, handler: PacketHandler): void {
    this.moduleHandlers.set(moduleId, handler);
  }

  unregisterModule(moduleId: string): void {
    this.moduleHandlers.delete(moduleId);
  }

  sendToModule(moduleId: string, packet: LmiPacket): Promise<unknown> {
    return Promise.resolve(this.moduleHandlers.get(moduleId)?.(packet));
  }

  publish(topic: string, packet: LmiPacket): void {
    this.topicHandlers.get(topic)?.forEach((handler) => {
      void handler(packet);
    });
  }

  subscribe(topic: string, handler: PacketHandler): () => void {
    const handlers = this.topicHandlers.get(topic) ?? new Set();
    handlers.add(handler);
    this.topicHandlers.set(topic, handlers);
    return () => handlers.delete(handler);
  }

  topics(): string[] {
    return [...this.topicHandlers.keys()].sort();
  }
}
