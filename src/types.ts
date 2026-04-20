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

export interface VideoReport {
  videoId: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string;
  videoUrl: string;
  projects: GitHubProject[];
}
