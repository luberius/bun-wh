export interface ReleaseInfo {
  tagName: string;
  zipUrl: string;
  isDraft: boolean;
  isPrerelease: boolean;
  repositoryName: string;
  targetCommitish: string;
}

export interface ProjectConfig {
  name: string;
  webRoot: string;
  githubRepo: string;
  extractPath: string;
  keepReleases: number;
  postExtract?: string[];
  preRollback?: string[];
  branch?: string;
}

export interface Config {
  projects: Record<string, ProjectConfig>;
  webhookSecret: string;
  githubToken?: string;
  baseDir: string;
}
