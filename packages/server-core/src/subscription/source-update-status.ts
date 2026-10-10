import { normalizeSavedSourcesForPersistence } from "./saved-sources";
import type { RefreshNodeSnapshotResult } from "./refresh-node-snapshot";

// Keep source identity with each result so editing/removing a URL cannot reuse an old result.
export function withSourceUpdateResults(config: Record<string, unknown>, snapshot: RefreshNodeSnapshotResult) {
  const failed = new Set(snapshot.failedSources.map((source) => source.id));
  return {
    ...config,
    sourceUpdateResults: snapshot.savedSources
      .filter((source) => source.type === "url" && !source.useProxyProviders)
      .map((source) => ({ id: source.id, content: source.content, status: failed.has(source.id) ? "failed" : "success" })),
  };
}

export function summarizeSourceUpdates(config: Record<string, unknown>, urls: string[] = []) {
  const sources = normalizeSavedSourcesForPersistence(config.sources, { fallbackUrls: urls })
    .filter((source) => source.type === "url" && !source.useProxyProviders);
  const results = Array.isArray(config.sourceUpdateResults) ? config.sourceUpdateResults : [];
  let succeeded = 0;
  let failed = 0;
  for (const source of sources) {
    const result = results.find((item) => item && typeof item === "object" &&
      item.id === source.id && item.content === source.content);
    if (result?.status === "success") succeeded += 1;
    if (result?.status === "failed") failed += 1;
  }
  return { total: sources.length, succeeded, failed };
}
