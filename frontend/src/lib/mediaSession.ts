// A song may intentionally use two synchronized media elements. Unregistered
// elements remain independent sessions and still exclude every other player.
const sessions = new WeakMap<HTMLMediaElement, symbol>();

export function registerMediaSession(owner: HTMLMediaElement, companion: HTMLMediaElement): () => void {
  const session = Symbol("media session");
  sessions.set(owner, session);
  sessions.set(companion, session);
  return () => {
    if (sessions.get(owner) === session) sessions.delete(owner);
    if (sessions.get(companion) === session) sessions.delete(companion);
  };
}

export function sameMediaSession(left: HTMLMediaElement, right: HTMLMediaElement): boolean {
  const session = sessions.get(left);
  return session !== undefined && session === sessions.get(right);
}

export function pauseOtherMedia(current: HTMLMediaElement, elements: Iterable<HTMLMediaElement>): void {
  if (current.paused) return;
  for (const audio of elements) {
    if (audio !== current && !audio.paused && !sameMediaSession(current, audio)) audio.pause();
  }
}
