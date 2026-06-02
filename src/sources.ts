import type { VideoSource } from './types.js';

export interface SourceConfig {
  source: VideoSource;
  /** max videos to fetch per run */
  maxVideos?: number;
}

export const SOURCES: SourceConfig[] = [
  {
    source: { label: 'GithubAwesome', type: 'channel', id: 'UC9Rrud-8CaHokDtK9FszvRg' },
  },
  {
    source: { label: 'ManuAGI – GitHub Projects', type: 'playlist', id: 'PLqPLI-F0UkmdvkuMYjrp1yCNdIk-0NShN' },
  },
];
