export interface SessionConfigMemory {
  receive(dataDir: string, message: unknown, owner?: unknown): boolean;
  commit(dataDir: string, requestId: string, owner?: unknown): boolean;
  finish(dataDir: string, requestId: string, owner?: unknown): boolean;
  cancel(dataDir: string, requestId: string): boolean;
  rejectProcess(owner: unknown): void;
  handleMessage(dataDir: string, owner: { postMessage(message: object): void }, message: unknown): boolean;
  childEnvironment(dataDir: string): Record<string, string>;
}

export function createSessionConfigMemory(): SessionConfigMemory;
