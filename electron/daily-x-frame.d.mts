export declare const DAILY_X_URL: string;
export declare const DAILY_X_FRAME_NAME: string;
export declare function dailyXPageAllowed(raw: unknown): boolean;
export declare function createDailyXFrameNavigation(): (details: unknown, mainFrame: unknown, localOrigin: string, initial?: boolean) => boolean | null;
export declare function installDailyXFrameGuards(webContents: unknown, options: {
  localOrigin(): string;
  redirectFallback(details: unknown, url: string): void;
  frameFallback(details: unknown): void;
}): void;
