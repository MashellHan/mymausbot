import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";

export const MINI_APP_FRAME_POOL_MAX = 4;

export interface PooledMiniAppSlot {
  appId: string;
  document: MiniAppDocument;
  state: MiniAppState;
  frameEpoch: number;
  lastUsedAt: number;
  pendingDataChanged: boolean;
}

export class MiniAppFramePoolState {
  private readonly maxAlive: number;
  private readonly slots = new Map<string, PooledMiniAppSlot>();

  constructor(maxAlive = MINI_APP_FRAME_POOL_MAX) {
    this.maxAlive = maxAlive;
  }

  activate(input: { appId: string; document: MiniAppDocument; state: MiniAppState; frameEpoch: number; now?: number }): {
    evicted: string[];
    flushedPendingData: boolean;
  } {
    const now = input.now ?? Date.now();
    const existing = this.slots.get(input.appId);
    const sameMount = existing
      && existing.document.app.templateVersion === input.document.app.templateVersion
      && existing.frameEpoch === input.frameEpoch;
    const flushedPendingData = Boolean(sameMount && existing?.pendingDataChanged);
    this.slots.delete(input.appId);
    this.slots.set(input.appId, {
      appId: input.appId,
      document: input.document,
      state: input.state,
      frameEpoch: input.frameEpoch,
      lastUsedAt: now,
      pendingDataChanged: false,
    });
    const evicted: string[] = [];
    while (this.slots.size > this.maxAlive) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined || oldest === input.appId) break;
      this.slots.delete(oldest);
      evicted.push(oldest);
    }
    return { evicted, flushedPendingData };
  }

  markDatasetDirty(activeAppId: string | null, datasetId: string, revision: number): string[] {
    const dirtied: string[] = [];
    for (const slot of this.slots.values()) {
      const bound = slot.state.data.find((entry) => entry.datasetId === datasetId);
      if (!bound || bound.revision >= revision) continue;
      slot.state = {
        ...slot.state,
        data: slot.state.data.map((entry) => (entry.datasetId === datasetId ? { ...entry, revision } : entry)),
      };
      if (slot.appId !== activeAppId) {
        slot.pendingDataChanged = true;
        dirtied.push(slot.appId);
      }
    }
    return dirtied;
  }

  retire(appId: string): boolean {
    return this.slots.delete(appId);
  }

  retireAll(): void {
    this.slots.clear();
  }

  get(appId: string): PooledMiniAppSlot | undefined {
    return this.slots.get(appId);
  }

  list(): PooledMiniAppSlot[] {
    return [...this.slots.values()];
  }
}
