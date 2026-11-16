// Screen Wake Lock for the length of a run (docs/SPEC.md, 4: all modes).
// The browser releases the lock when the tab is hidden, so it is requested
// again when the tab becomes visible. Unsupported or refused: the run goes on
// and the page says the screen may sleep.

export type WakeState = 'on' | 'unsupported' | 'refused';

export function holdWakeLock(onState: (s: WakeState) => void): () => void {
  const wl = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
  if (!wl) {
    onState('unsupported');
    return () => {};
  }
  let lock: WakeLockSentinel | undefined;
  let ended = false;
  /** A request is in flight: a visibilitychange meanwhile must not take a second lock. */
  let pending = false;
  const acquire = () => {
    if (ended || pending || document.hidden || (lock && !lock.released)) return;
    pending = true;
    wl.request('screen').then(
      (l) => {
        pending = false;
        if (ended) void l.release().catch(() => {});
        else {
          lock = l;
          onState('on');
        }
      },
      () => {
        pending = false;
        onState('refused');
      },
    );
  };
  const onVis = () => acquire();
  document.addEventListener('visibilitychange', onVis);
  acquire();
  return () => {
    ended = true;
    document.removeEventListener('visibilitychange', onVis);
    void lock?.release().catch(() => {});
  };
}
