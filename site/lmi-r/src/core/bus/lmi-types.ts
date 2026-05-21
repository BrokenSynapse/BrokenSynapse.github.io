export type LmiAddressKind = 'system' | 'shell' | 'module' | 'user' | 'entity' | 'asset' | 'server';
export type LmiScope = 'local' | 'session' | 'user' | 'profile' | 'server' | 'broadcast';
export type LmiRefKind = 'asset' | 'entity' | 'blob' | 'module' | 'file';

export interface LmiAddress {
  kind: LmiAddressKind;
  id: string;
}

export interface LmiRef {
  kind: LmiRefKind;
  id: string;
  mime?: string;
  size?: number;
}

export interface EntityQuery {
  kind?: string;
  ownerId?: string;
  limit?: number;
}

export interface LmiAssetRef {
  ref: string;
  kind: 'asset';
  id: string;
  mime?: string;
  size?: number;
  url?: string;
}

export interface BusDebugView {
  registeredModules: Array<{ id: string; name: string; capabilities: string[] }>;
  recentPackets: Array<{ id: string; op: number; source: LmiAddress; target?: LmiAddress; scope: LmiScope; ts: number; payload?: unknown }>;
  knownTopics: string[];
  pendingRequestCount: number;
  stateKeys: string[];
}
