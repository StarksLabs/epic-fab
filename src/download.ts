// Asset download + chunk reassembly. Implements step 2-and-a-half of docs/api-surface.md §3.4:
// walks the parsed manifest's per-file chunk-part list, fetches each unique chunk from the CDN
// (cached, deduplicated, bounded concurrency), slices the requested byte range out of each
// decoded chunk payload, and assembles the file on disk.

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import type { FabAssetDetail, FabDownloadFile } from "./api.ts";
import { chunkPath, decodeChunkPayload, type ChunkInfo, type ChunkPart } from "./manifestParser.ts";

export interface DownloadOptions {
  targetDir: string;
  preserveStructure: boolean;
  /** Suppress the built-in stderr progress lines for an interactive caller. */
  quiet?: boolean;
  /** Max concurrent CDN chunk fetches. Default 8; Epic CDNs often rate-limit around 16+. */
  concurrency?: number;
  /** Skip files whose on-disk SHA1 already matches the manifest. Default true. */
  skipExisting?: boolean;
  /** Retries per CDN base URL on transient fetch failures. Default 2. */
  retries?: number;
  /**
   * How many unique chunk GUIDs to keep prefetched ahead of the assembly cursor.
   * Default = concurrency * 3. Higher = faster but more RAM.
   */
  prefetchWindow?: number;
}

const DEFAULT_CHUNK_CONCURRENCY = 8;
const DEFAULT_RETRIES = 2;

function safeRelativePath(filename: string): string {
  // Defense against malicious filenames in manifest entries: collapse `..`, drop absolute roots.
  // Manifests carry Windows-style backslashes; normalize first so split(sep) catches both.
  const unix = filename.replace(/\\/g, "/");
  const normalized = normalize(unix).replace(/^([/\\]+)/, "");
  const parts = normalized.split(/[/\\]/).filter((part) => part.length > 0 && part !== "..");
  return parts.join(sep);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchChunkBytes(
  chunk: ChunkInfo,
  distributionBaseUrls: ReadonlyArray<string>,
  manifestVersion: number,
  retries: number,
): Promise<Uint8Array> {
  let lastError: Error | undefined;

  for (let baseIndex = 0; baseIndex < distributionBaseUrls.length; baseIndex++) {
    const distributionBaseUrl = distributionBaseUrls[baseIndex]!;
    const url = chunkPath(chunk, distributionBaseUrl, manifestVersion);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return new Uint8Array(await response.arrayBuffer());
        }

        lastError = new Error(
          `Chunk fetch failed for ${chunk.guid}: HTTP ${response.status} (${distributionBaseUrl})`,
        );

        // 403/404: often stale signature or wrong host — retry a bit, then next CDN.
        // 408/429/5xx: transient — retry with backoff, then next CDN.
        // Other 4xx: fail this host immediately and try next base.
        const retryable =
          isRetryableStatus(response.status) ||
          response.status === 403 ||
          response.status === 404;
        if (!retryable) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < retries) {
        // Exponential backoff with small jitter: 200ms, 400ms, 800ms...
        await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
  }

  throw lastError ?? new Error(`Chunk fetch failed for ${chunk.guid}: no distribution bases`);
}

// Bounded-concurrency cache with refcounted eviction. Multiple files share chunks — each unique
// GUID is fetched once while still referenced. When remainingUses hits 0 the decoded payload is
// dropped so large assets do not hold every chunk in RAM for the whole download.
class ChunkCache {
  private readonly resolved = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly chunkInfoById: ReadonlyMap<string, ChunkInfo>,
    private readonly distributionBaseUrls: ReadonlyArray<string>,
    private readonly manifestVersion: number,
    private readonly maxConcurrent: number,
    private readonly retries: number,
    private readonly remainingUses: Map<string, number>,
  ) {}

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Kick off a fetch without awaiting — fills the concurrency pool. */
  prime(guid: string): void {
    void this.get(guid);
  }

  async get(guid: string): Promise<Uint8Array> {
    const hit = this.resolved.get(guid);
    if (hit) return hit;

    const cached = this.inflight.get(guid);
    if (cached) return cached;

    const chunk = this.chunkInfoById.get(guid);
    if (!chunk) {
      throw new Error(`Unknown chunk GUID in file manifest: ${guid}`);
    }

    const promise = (async () => {
      await this.acquire();
      try {
        // Another waiter may have finished while we queued on the semaphore.
        const raced = this.resolved.get(guid);
        if (raced) return raced;

        const raw = await fetchChunkBytes(
          chunk,
          this.distributionBaseUrls,
          this.manifestVersion,
          this.retries,
        );
        const decoded = decodeChunkPayload(raw);
        // Only keep if still needed (refcount may have been fully consumed elsewhere — rare).
        if ((this.remainingUses.get(guid) ?? 0) > 0) {
          this.resolved.set(guid, decoded);
        }
        return decoded;
      } finally {
        this.inflight.delete(guid);
        this.releaseSlot();
      }
    })();
    this.inflight.set(guid, promise);
    return promise;
  }

  /** One part consumed this GUID — drop decoded bytes when no remaining uses. */
  consume(guid: string): void {
    const left = (this.remainingUses.get(guid) ?? 0) - 1;
    if (left <= 0) {
      this.remainingUses.delete(guid);
      this.resolved.delete(guid);
      // Leave inflight alone — in-flight fetch still completes, result just won't stay cached.
    } else {
      this.remainingUses.set(guid, left);
    }
  }

  /** Unique GUIDs currently held decoded in RAM (for status). */
  cachedCount(): number {
    return this.resolved.size;
  }
}

function countGuidUses(files: ReadonlyArray<FabDownloadFile>): Map<string, number> {
  const uses = new Map<string, number>();
  for (const file of files) {
    for (const part of file.chunkParts) {
      uses.set(part.guid, (uses.get(part.guid) ?? 0) + 1);
    }
  }
  return uses;
}

/** Flat ordered stream of GUIDs as assembly will consume them (duplicates preserved). */
function guidConsumptionOrder(files: ReadonlyArray<FabDownloadFile>): string[] {
  const order: string[] = [];
  for (const file of files) {
    for (const part of file.chunkParts) {
      order.push(part.guid);
    }
  }
  return order;
}

/**
 * Sliding-window prefether: keep up to `windowSize` unique not-yet-consumed GUIDs in flight
 * starting from `cursor` in the consumption order. Does not re-prime already-seen GUIDs in the
 * window scan beyond first encounter at/after cursor.
 */
function primeWindow(
  cache: ChunkCache,
  order: ReadonlyArray<string>,
  cursor: number,
  windowSize: number,
): void {
  const primed = new Set<string>();
  for (let i = cursor; i < order.length && primed.size < windowSize; i++) {
    const guid = order[i]!;
    if (primed.has(guid)) continue;
    primed.add(guid);
    cache.prime(guid);
  }
}

function distributionBases(asset: FabAssetDetail): string[] {
  // Primary first, then remaining unique bases from multi-CDN pointers.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    asset.distributionBaseUrl,
    ...asset.manifestPointers.map((p) => p.distributionBaseUrl),
  ];
  for (const base of candidates) {
    const normalized = base.replace(/\/+$/, "");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

async function fileMatchesHash(targetPath: string, expectedHash: string, expectedSize: number): Promise<boolean> {
  if (expectedHash.length === 0 || expectedHash === "0".repeat(40)) return false;
  try {
    const info = await stat(targetPath);
    if (!info.isFile() || info.size !== expectedSize) return false;
    const bytes = await readFile(targetPath);
    const got = Bun.SHA1.hash(bytes, "hex");
    return got === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Stream-assemble one file to disk. Parts stay ordered; each part's chunk is refcount-consumed
 * after copy so decoded payloads are freed as soon as no later part needs them. Avoids holding
 * the full file buffer + all chunks in RAM (the previous OOM path on large assets).
 */
async function assembleFile(
  file: FabDownloadFile,
  cache: ChunkCache,
  targetPath: string,
  order: ReadonlyArray<string>,
  orderCursor: { value: number },
  prefetchWindow: number,
): Promise<number> {
  await mkdir(dirname(targetPath), { recursive: true });

  const tmpPath = `${targetPath}.partial`;
  const handle = await open(tmpPath, "w");
  const hasher =
    file.fileHash.length > 0 && file.fileHash !== "0".repeat(40)
      ? new Bun.CryptoHasher("sha1")
      : null;

  let writeOffset = 0;
  try {
    for (const part of file.chunkParts) {
      // Keep CDN pool busy a window ahead of the assembly cursor.
      primeWindow(cache, order, orderCursor.value, prefetchWindow);

      const payload = await cache.get(part.guid);
      if (part.offset + part.size > payload.length) {
        throw new Error(
          `Chunk ${part.guid} too small for part (need ${part.offset + part.size}, have ${payload.length})`,
        );
      }
      const slice = payload.subarray(part.offset, part.offset + part.size);
      const wrote = await handle.write(slice, 0, slice.byteLength, writeOffset);
      if (wrote.bytesWritten !== slice.byteLength) {
        throw new Error(
          `Short write for ${file.filename} at offset ${writeOffset}: wrote ${wrote.bytesWritten}, expected ${slice.byteLength}`,
        );
      }
      if (hasher) hasher.update(slice);
      writeOffset += part.size;

      cache.consume(part.guid);
      orderCursor.value += 1;
    }

    if (writeOffset !== file.size) {
      throw new Error(
        `Assembled byte count mismatch for ${file.filename}: wrote ${writeOffset}, expected ${file.size}`,
      );
    }

    if (hasher) {
      const got = hasher.digest("hex");
      if (got !== file.fileHash.toLowerCase()) {
        throw new Error(
          `SHA1 mismatch for ${file.filename}: got ${got}, want ${file.fileHash.toLowerCase()}`,
        );
      }
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    // Best-effort cleanup of partial file on failure.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  await handle.close();
  await rename(tmpPath, targetPath);
  return writeOffset;
}

export async function downloadAsset(
  asset: FabAssetDetail,
  opts: DownloadOptions,
): Promise<{ files: string[]; bytesTotal: number; skipped: number }> {
  if (asset.downloadUrls.length === 0) {
    throw new Error(`Asset ${asset.id} has no files in its manifest`);
  }

  await mkdir(opts.targetDir, { recursive: true });

  const concurrency = opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const skipExisting = opts.skipExisting ?? true;
  const prefetchWindow = opts.prefetchWindow ?? concurrency * 3;
  const bases = distributionBases(asset);
  if (bases.length === 0) {
    throw new Error(`Asset ${asset.id} has no distribution base URLs`);
  }

  const fileTotal = asset.downloadUrls.length;
  const writtenFiles: string[] = [];
  let bytesTotal = 0;
  let filesDone = 0;
  let skipped = 0;

  // Plan first: resolve paths + skip hash matches before any CDN work.
  type PlannedFile = {
    file: FabDownloadFile;
    relativePath: string;
    targetPath: string;
  };
  const toDownload: PlannedFile[] = [];

  if (skipExisting && !opts.quiet) {
    process.stderr.write(`Checking ${fileTotal} on-disk file(s) for SHA1 match…\n`);
  }

  for (const file of asset.downloadUrls) {
    const relativePath = opts.preserveStructure
      ? safeRelativePath(file.filename)
      : safeRelativePath(file.filename.split(/[/\\]/).pop() ?? file.filename);
    const targetPath = join(opts.targetDir, relativePath);

    if (skipExisting && (await fileMatchesHash(targetPath, file.fileHash, file.size))) {
      writtenFiles.push(targetPath);
      bytesTotal += file.size;
      filesDone += 1;
      skipped += 1;
      if (!opts.quiet) process.stderr.write(`[${filesDone}/${fileTotal}] skip ${relativePath}\n`);
      continue;
    }

    toDownload.push({ file, relativePath, targetPath });
  }

  if (toDownload.length === 0) {
    if (!opts.quiet) process.stderr.write(`Nothing to fetch — all ${skipped} file(s) already match manifest SHA1\n`);
    return { files: writtenFiles, bytesTotal, skipped };
  }

  const filesOnly = toDownload.map((p) => p.file);
  const remainingUses = countGuidUses(filesOnly);
  const uniqueNeeded = remainingUses.size;
  const order = guidConsumptionOrder(filesOnly);
  const orderCursor = { value: 0 };

  const cache = new ChunkCache(
    asset.chunkInfoById,
    bases,
    asset.manifestVersion,
    concurrency,
    retries,
    remainingUses,
  );

  if (!opts.quiet) {
    process.stderr.write(
      `Downloading ${toDownload.length}/${fileTotal} file(s), ${uniqueNeeded} unique chunk(s)` +
        ` (concurrency ${concurrency}, prefetch window ${prefetchWindow}` +
        (bases.length > 1 ? `, ${bases.length} CDN bases` : "") +
        ")…\n",
    );
  }

  // Kick the first window so the pool is busy before assembly starts.
  primeWindow(cache, order, 0, prefetchWindow);

  for (const { file, relativePath, targetPath } of toDownload) {
    if (!opts.quiet) process.stderr.write(`[${filesDone + 1}/${fileTotal}] downloading ${relativePath}…\n`);
    const bytes = await assembleFile(
      file,
      cache,
      targetPath,
      order,
      orderCursor,
      prefetchWindow,
    );
    writtenFiles.push(targetPath);
    bytesTotal += bytes;
    filesDone += 1;
    if (!opts.quiet) {
      process.stderr.write(
        `[${filesDone}/${fileTotal}] wrote ${relativePath} (${bytes} bytes, cache ${cache.cachedCount()} chunks)\n`,
      );
    }
  }

  return { files: writtenFiles, bytesTotal, skipped };
}

// Re-export for callers that want types without crossing module boundaries.
export type { ChunkInfo, ChunkPart };
