export type Capability = 'ask' | 'search_game_info' | 'join' | 'leave' | 'configure' | 'shutdown';
export class AuthorizationError extends Error {
  constructor() { super('Ação reservada ao criador autenticado do Jarvis.'); }
}

export function authorize(actorId: string, capability: Capability, ownerId: string): void {
  if (capability === 'ask' || capability === 'search_game_info') return;
  if (actorId !== ownerId) throw new AuthorizationError();
}
