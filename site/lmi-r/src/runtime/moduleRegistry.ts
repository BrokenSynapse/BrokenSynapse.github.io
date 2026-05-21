export interface ModuleDefinition {
  id: string;
  name: string;
  phase: 'stub' | 'compat-planned' | 'native';
}

export interface ModuleRegistry {
  list(): ModuleDefinition[];
  get(id: string): ModuleDefinition | undefined;
}

const modules: ModuleDefinition[] = [
  { id: 'settings', name: 'Settings.LMX', phase: 'stub' },
  { id: 'sift', name: 'Sift.LMX', phase: 'stub' },
  { id: 'fleetline', name: 'Fleetline.LMX', phase: 'compat-planned' },
  { id: 'dataforge', name: 'DataForge.LMX', phase: 'compat-planned' }
];

export const moduleRegistry: ModuleRegistry = {
  list: () => [...modules],
  get: (id: string) => modules.find((module) => module.id === id)
};
