export type MuseVisualInput = { pageId: string; objectId: string; dataUrl: string; kind?: 'image' | 'scene' };

export type MusePreparedContext = {
  board: string;
  project?: string;
  images?: MuseVisualInput[];
  anchorIds?: string[];
};

export type MuseProgress = 'context' | 'research' | 'vision' | 'thinking' | 'saving';
export const museProgressLabel: Record<MuseProgress, string> = {
  context: 'Reading your board…',
  research: 'Checking sources…',
  vision: 'Looking at the visuals…',
  thinking: 'Working on it…',
  saving: 'Finishing up…',
};
