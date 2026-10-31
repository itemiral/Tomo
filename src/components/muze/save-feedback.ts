export type SaveStatus = 'Saved on this device' | 'Saving…' | 'Not saved';
export const SAVE_FEEDBACK_DELAY = 2500;

// Only delay the feedback, never the write. A burst shares one timer so a slow
// save remains visible even while more edits arrive. Each write is a complete
// workspace snapshot; only the latest result can describe its saved state.
export function createSaveFeedback(status: (value: SaveStatus) => void, error: () => void) {
  let version = 0, pending = false, disposed = false, failed = false;
  let scope: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };

  return {
    track(write: () => Promise<void>, boardId: string): Promise<void> {
      if (disposed) return Promise.resolve();
      const current = ++version;
      if (scope !== boardId) {
        clear(); pending = false; scope = boardId;
        if (!failed) status('Saved on this device');
      }
      if (!pending) {
        pending = true;
        timer = setTimeout(() => { if (!disposed && pending && !failed) status('Saving…'); }, SAVE_FEEDBACK_DELAY);
      }
      let saved: Promise<void>;
      try { saved = write(); } catch (cause) { saved = Promise.reject(cause); }
      return saved.then(() => {
        if (disposed || current !== version) return;
        clear(); pending = false; failed = false; status('Saved on this device');
      }, () => {
        if (disposed || current !== version) return;
        clear(); pending = false; failed = true; status('Not saved'); error();
      });
    },
    dispose() { disposed = true; version++; clear(); pending = false; },
  };
}
