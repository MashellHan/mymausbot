export declare const GITHUB_ACTIVITY_URL: string;
export declare const GITHUB_ACTIVITY_FRAME_NAME: string;
export declare function githubActivityPageAllowed(raw: unknown): boolean;
export declare function githubMediaUrlAllowed(raw: unknown): boolean;
export declare function createGithubActivityFrameNavigation(): (details: unknown, mainFrame: unknown, localOrigin: string, initial?: boolean) => boolean | null;
export declare function createGithubActivityFrameGuards(options: {
  webContents: unknown;
  localOrigin(): string;
  redirectFallback(details: unknown, url: string): void;
  frameFallback(details: unknown, url?: string): void;
}): {
  redirectFallback(details: unknown, url: string): void;
  frameFallback(details: unknown, url?: string): void;
};
