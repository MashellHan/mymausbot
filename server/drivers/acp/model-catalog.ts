import { createHash } from "node:crypto";

import type { ModelListProblem } from "../../../shared/model-selection.ts";
import type { ModelCatalog } from "../../contracts.ts";
import {
  readStartupModelCacheEntry, setStartupModelCacheSource, startupModelCacheSource, unconfirmedModelCatalog, writeStartupModelCache,
} from "../../startup-model-catalog.ts";
import { interruptedVariantReads } from "./custom-model-catalog.ts";

export interface AcpModelCatalog {
  models: ModelCatalog;
  /** The models the signed-in account offers, once the engine has listed them. */
  accountModels: ReadonlySet<string> | null;
  /** True while this process has not been given the list by the engine: the driver's fixed one, a saved stand-in,
   * or a failed read's leftover. */
  readonly unconfirmed: boolean;
  /** While unconfirmed after a failed read: why it failed. */
  readonly unreadable: ModelListProblem | undefined;
  /** A read already under way is shared; a fresh one waits for a cached one under way, then reads again. */
  refresh(fresh?: boolean): Promise<void>;
}

export function acpModelCatalogSource(driverKind: string, cli: string): string {
  return createHash("sha256").update(JSON.stringify([driverKind, cli])).digest("hex");
}

export function acpModelCatalog(input: {
  instanceId: string;
  source: string;
  fixed: ModelCatalog;
  startFromSaved: boolean;
  resolve?: (fresh: boolean) => ModelCatalog | Promise<ModelCatalog>;
  /** Names why a read failed; without it a failure is "failed". */
  explain?: (error: unknown) => ModelListProblem;
}): AcpModelCatalog {
  const { instanceId, source, resolve } = input;
  const saved = resolve ? readStartupModelCacheEntry(instanceId, source) : null;
  let models = input.startFromSaved ? saved?.catalog ?? input.fixed : input.fixed;
  // A previous run's checkedAt only lets the file stand in. This process confirms the ids when its own read returns them.
  let readFromEngine = false;
  let accountModels: ReadonlySet<string> | null = saved?.checkedAt && startupModelCacheSource(saved.catalog) === source
    ? idsOf(saved.catalog) : null;
  let current: { fresh: boolean; done: Promise<void> } | null = null;
  let problem: ModelListProblem | undefined;

  const read = async (fresh: boolean) => {
    if (!resolve) return;
    try {
      const resolved = await resolve(fresh);
      if (resolved.options.length) {
        const interrupted = interruptedVariantReads(resolved);
        models = interrupted && startupModelCacheSource(models) === source
          ? withEarlierVariants(resolved, models, interrupted) : { ...resolved };
        setStartupModelCacheSource(models, source);
        if (interrupted) unconfirmedModelCatalog(models);
        readFromEngine = true;
        accountModels = idsOf(resolved);
        problem = undefined;
      } else {
        unconfirmedModelCatalog(models);
        problem = "failed";
      }
    } catch (error) {
      unconfirmedModelCatalog(models);
      problem = "failed";
      try { problem = input.explain?.(error) ?? problem; } catch {}
    }
    try { writeStartupModelCache(instanceId, models); } catch {}
  };

  return {
    get models() { return models; },
    set models(catalog) { models = catalog; },
    get accountModels() { return accountModels; },
    set accountModels(ids) { accountModels = ids; },
    get unconfirmed() { return Boolean(resolve) && !readFromEngine; },
    get unreadable() { return Boolean(resolve) && !readFromEngine ? problem : undefined; },
    refresh(fresh = false) {
      if (current && (current.fresh || !fresh)) return current.done;
      const next = { fresh, done: (current?.done ?? Promise.resolve()).then(() => read(fresh)) };
      current = next;
      void next.done.finally(() => { if (current === next) current = null; });
      return next.done;
    },
  };
}

function withEarlierVariants(catalog: ModelCatalog, earlier: ModelCatalog, interrupted: ReadonlySet<string>): ModelCatalog {
  const earlierOptions = new Map(earlier.options.map((option) => [option.id, option]));
  return {
    ...catalog,
    options: catalog.options.map((option) => {
      if (!interrupted.has(option.id)) return option;
      const previous = earlierOptions.get(option.id);
      if (!previous?.variants?.length || previous.provider !== option.provider) return option;
      return { ...option, variants: previous.variants };
    }),
  };
}

function idsOf(catalog: ModelCatalog): ReadonlySet<string> {
  return new Set(catalog.options.map((option) => option.id));
}
