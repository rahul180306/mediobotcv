/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ImagePreprocessCacheOptions {
  /** Maximum total bytes of cached images. Default: 20 MB (20,971,520 bytes) */
  maxBytes?: number;
  /** Maximum number of entries. Default: 25 */
  maxEntries?: number;
}

export interface ImagePreprocessCacheStats {
  entries: number;
  currentBytes: number;
  maxBytes: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Byte-aware LRU cache for preprocessed and resized observation images.
 * Replaces entry-count-only limits with explicit byte limits, ensuring
 * that retained image memory is bounded and that eviction releases references
 * to base64 string buffers for prompt garbage collection.
 */
export class ImagePreprocessCache {
  private readonly cache = new Map<string, { value: string; bytes: number }>();
  private currentBytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options?: ImagePreprocessCacheOptions) {
    this.maxBytes = options?.maxBytes ?? 20 * 1024 * 1024; // 20 MB
    this.maxEntries = options?.maxEntries ?? 25;
  }

  /**
   * Retrieves a cached image if available. Promotes entry to MRU.
   */
  public get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Re-insert into Map to update LRU order (most recently accessed at the end)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /**
   * Caches a preprocessed image string, evicting oldest entries if
   * byte limit or entry limit is exceeded.
   */
  public set(key: string, value: string): void {
    const existing = this.cache.get(key);
    if (existing) {
      this.currentBytes -= existing.bytes;
      this.cache.delete(key);
    }

    // In JS/V8 engines, a string consumes ~2 bytes per UTF-16 code unit
    const entryBytes = (key.length + value.length) * 2;

    // Evict oldest (LRU) until within limits
    while (
      (this.currentBytes + entryBytes > this.maxBytes ||
        this.cache.size >= this.maxEntries) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;

      const oldestEntry = this.cache.get(oldestKey);
      if (oldestEntry) {
        this.currentBytes -= oldestEntry.bytes;
      }
      this.cache.delete(oldestKey);
      this.evictions++;
    }

    this.cache.set(key, { value, bytes: entryBytes });
    this.currentBytes += entryBytes;
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  public delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    this.currentBytes -= entry.bytes;
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
    this.currentBytes = 0;
  }

  public getStats(): ImagePreprocessCacheStats {
    return {
      entries: this.cache.size,
      currentBytes: this.currentBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /**
   * Evicts entries down to a target byte limit.
   */
  public evictToByteLimit(targetBytes: number): void {
    while (this.currentBytes > targetBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;

      const oldestEntry = this.cache.get(oldestKey);
      if (oldestEntry) {
        this.currentBytes -= oldestEntry.bytes;
      }
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }
}
