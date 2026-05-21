export interface ModuleDefinition {
  id: string;
  name: string;
  phase: 'stub' | 'compat-planned' | 'native';
  capabilities: string[];
}

export interface ModuleRegistry {
  list(): ModuleDefinition[];
  get(id: string): ModuleDefinition | undefined;
}

const modules: ModuleDefinition[] = [
  { id: 'settings', name: 'Settings.LMX', phase: 'stub', capabilities: ['state:read', 'state:write', 'user:read', 'user:write', 'asset:read'] },
  { id: 'sift', name: 'Sift.LMX', phase: 'stub', capabilities: ['asset:read', 'asset:write', 'entity:read', 'entity:write', 'event:publish'] },
  { id: 'fleetline', name: 'Fleetline.LMX', phase: 'compat-planned', capabilities: ['entity:read', 'asset:read', 'app:open', 'event:subscribe'] },
  { id: 'dataforge', name: 'DataForge.LMX', phase: 'compat-planned', capabilities: ['debug:read', 'entity:read', 'entity:write', 'state:read', 'state:write'] }
];

export const moduleRegistry: ModuleRegistry = {
  list: () => [...modules],
  get: (id: string) => modules.find((module) => module.id === id)
};
