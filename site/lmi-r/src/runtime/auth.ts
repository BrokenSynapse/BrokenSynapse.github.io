export interface AuthSession {
  mode: 'placeholder';
  actorTag: string;
  canWrite: boolean;
}

export function createAuthSession(): AuthSession {
  return {
    mode: 'placeholder',
    actorTag: 'local-operator',
    canWrite: false
  };
}
