export type LmiCapability =
  | 'state:read'
  | 'state:write'
  | 'entity:read'
  | 'entity:write'
  | 'asset:read'
  | 'asset:write'
  | 'app:open'
  | 'event:publish'
  | 'event:subscribe'
  | 'user:read'
  | 'user:write'
  | 'debug:read';

export function hasCapability(capabilities: readonly string[], capability: LmiCapability): boolean {
  return capabilities.includes(capability);
}
