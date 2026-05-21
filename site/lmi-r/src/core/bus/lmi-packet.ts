import type { LmiAddress, LmiRef, LmiScope } from './lmi-types';

export interface LmiPacket {
  id: string;
  op: number;
  source: LmiAddress;
  target?: LmiAddress;
  scope: LmiScope;
  flags: number;
  ts: number;
  rev?: number;
  payload?: unknown;
  refs?: LmiRef[];
}

export function createPacket(input: Omit<LmiPacket, 'id' | 'ts' | 'flags'> & { id?: string; ts?: number; flags?: number }): LmiPacket {
  return {
    id: input.id ?? crypto.randomUUID(),
    op: input.op,
    source: input.source,
    target: input.target,
    scope: input.scope,
    flags: input.flags ?? 0,
    ts: input.ts ?? Date.now(),
    rev: input.rev,
    payload: input.payload,
    refs: input.refs
  };
}
