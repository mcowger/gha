export interface ReviewedVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  retrievedAt: string;
  projectCount: number;
}

export interface StateFile {
  videos: ReviewedVideo[];
}

export interface GitHubProject {
  owner: string;
  repo: string;
  url: string;
  readme: string | null;
  summary: string | null;
  description: string | null;
  stars: number | null;
  language: string | null;
  error?: string;
}

export interface VideoSource {
  label: string;
  type: 'channel' | 'playlist';
  id: string;
}

/** One video that mentioned a given repo. */
export interface RepoMention {
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  mentionedAt: string;
  source?: VideoSource;
}

/** A GitHub repo discovered from one or more videos, keyed by owner/repo. */
export interface RepoEntry {
  owner: string;
  repo: string;
  url: string;
  description: string | null;
  stars: number | null;
  language: string | null;
  summary: string | null;
  firstDiscoveredAt: string;
  mentions: RepoMention[];
  viewed?: boolean;
  starred?: boolean;
}

/** One of the authenticated user's GitHub Lists (star-organizing lists). */
export interface GitHubList {
  id: string;
  name: string;
}

export interface RepoStateFile {
  repos: RepoEntry[];
}
