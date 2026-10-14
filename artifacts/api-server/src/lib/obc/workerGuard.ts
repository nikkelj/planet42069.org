/** Keep ownership for the entire tick, including retry sleeps. Never queue ticks. */
export function createWorkerGuard() {
  const active = new Set<string>();
  return async (label: string, work: () => Promise<void>): Promise<boolean> => {
    if (active.has(label)) return false;
    active.add(label);
    try {
      await work();
      return true;
    } finally {
      active.delete(label);
    }
  };
}
