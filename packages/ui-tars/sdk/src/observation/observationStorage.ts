/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { replaceBase64Prefix } from '../utils';

export enum SessionObservationState {
  ACTIVE = 'active',
  RETAINED = 'retained',
  DISPOSED = 'disposed',
}

export interface SessionRecord {
  sessionId: string;
  state: SessionObservationState;
  createdAt: number;
  lastAccessedAt: number;
  screenshotCount: number;
}

export interface ObservationStorageOptions {
  baseDir?: string;
  maxStaleAgeMs?: number;
}

/**
 * Manages session-scoped ephemeral screenshot storage.
 * Stores observation screenshots to temporary files on disk,
 * allowing in-memory base64 buffers to be pruned while preserving
 * full retrieval capability and safe lifecycle cleanup.
 */
export class ObservationStorage {
  private static instance: ObservationStorage;
  private readonly baseDir: string;
  private cleanedStale = false;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options?: ObservationStorageOptions) {
    this.baseDir =
      options?.baseDir || path.join(os.tmpdir(), 'mediobot-cu', 'sessions');
    this.ensureBaseDir();
    this.rehydrateSessions();
    // Non-blocking stale session cleanup
    this.cleanStaleSessions(options?.maxStaleAgeMs).catch(() => {});
  }

  public static getInstance(options?: ObservationStorageOptions): ObservationStorage {
    if (!ObservationStorage.instance) {
      ObservationStorage.instance = new ObservationStorage(options);
    }
    return ObservationStorage.instance;
  }

  public static resetInstanceForTesting(): void {
    (ObservationStorage as any).instance = undefined;
  }

  private ensureBaseDir(): void {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch {
      // Ignore if directory creation fails or exists
    }
  }

  /**
   * Rehydrates existing session records from disk following application restart.
   * Unclosed ACTIVE sessions are transitioned to RETAINED to ensure legitimate
   * recorded screenshots remain accessible to session viewers.
   */
  private rehydrateSessions(): void {
    try {
      if (!fs.existsSync(this.baseDir)) return;
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.meta.json')) {
          const metaPath = path.join(this.baseDir, entry.name);
          try {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const record = JSON.parse(raw) as SessionRecord;
            if (record && record.sessionId) {
              // If previous process crashed or closed while ACTIVE, rehydrate as RETAINED
              if (record.state === SessionObservationState.ACTIVE) {
                record.state = SessionObservationState.RETAINED;
              }
              this.sessions.set(record.sessionId, record);
            }
          } catch {
            // Ignore invalid metadata files
          }
        }
      }
    } catch {
      // Safe no-op on read failure
    }
  }

  public getSessionMetaPath(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${sanitized}.meta.json`);
  }

  private saveSessionMeta(sessionId: string): void {
    try {
      const record = this.sessions.get(sessionId);
      if (!record) return;
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      const metaPath = this.getSessionMetaPath(sessionId);
      fs.writeFileSync(metaPath, JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // Safe no-op on write failure
    }
  }

  public getSessionDir(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, sanitized);
  }

  /**
   * Registers a session as actively running. Active sessions are protected
   * against stale-file garbage collection.
   */
  public registerActiveSession(sessionId: string): void {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.state = SessionObservationState.ACTIVE;
      existing.lastAccessedAt = now;
    } else {
      this.sessions.set(sessionId, {
        sessionId,
        state: SessionObservationState.ACTIVE,
        createdAt: now,
        lastAccessedAt: now,
        screenshotCount: 0,
      });
    }
    this.saveSessionMeta(sessionId);
  }

  /**
   * Marks a session as retained (agent execution finished or stopped,
   * but observation history is retained for the UI/viewer).
   * Retained sessions remain protected from stale-file cleanup.
   */
  public retainSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.state = SessionObservationState.RETAINED;
      record.lastAccessedAt = Date.now();
    } else {
      const now = Date.now();
      this.sessions.set(sessionId, {
        sessionId,
        state: SessionObservationState.RETAINED,
        createdAt: now,
        lastAccessedAt: now,
        screenshotCount: 0,
      });
    }
    this.saveSessionMeta(sessionId);
  }

  /**
   * Checks whether a session is protected from cleanup (active or retained).
   */
  public isSessionProtected(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return (
      record?.state === SessionObservationState.ACTIVE ||
      record?.state === SessionObservationState.RETAINED
    );
  }

  public getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  public touchSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.lastAccessedAt = Date.now();
      this.saveSessionMeta(sessionId);
    }
  }

  /**
   * Persists a screenshot buffer to session-scoped scratch storage.
   * @param sessionId Session identifier
   * @param step Step or turn index
   * @param base64 Raw or data-prefixed base64 screenshot
   * @returns Absolute path to saved screenshot file
   */
  public async saveScreenshot(
    sessionId: string,
    step: number,
    base64: string,
  ): Promise<string> {
    const sessionDir = this.getSessionDir(sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const rawData = replaceBase64Prefix(base64);
    const buffer = Buffer.from(rawData, 'base64');
    const filePath = path.join(sessionDir, `step_${step}.jpg`);

    await fs.promises.writeFile(filePath, buffer);

    const record = this.sessions.get(sessionId);
    if (record) {
      record.lastAccessedAt = Date.now();
      record.screenshotCount++;
    }
    this.saveSessionMeta(sessionId);

    return filePath;
  }

  /**
   * Loads a screenshot from disk as a base64 string.
   * @param filePath Absolute path to screenshot
   */
  public async loadScreenshotBase64(filePath: string): Promise<string | null> {
    try {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Loads a screenshot by session id and step index.
   */
  public async loadScreenshotByStep(
    sessionId: string,
    step: number,
  ): Promise<string | null> {
    const sessionDir = this.getSessionDir(sessionId);
    const filePath = path.join(sessionDir, `step_${step}.jpg`);
    return this.loadScreenshotBase64(filePath);
  }

  /**
   * Explicitly disposes all temporary files for a specific session.
   * Marks session as DISPOSED and removes it from protected tracking.
   * @param sessionId Session identifier
   */
  public async disposeSession(sessionId: string): Promise<void> {
    try {
      const record = this.sessions.get(sessionId);
      if (record) {
        record.state = SessionObservationState.DISPOSED;
      }
      this.sessions.delete(sessionId);

      const sessionDir = this.getSessionDir(sessionId);
      if (fs.existsSync(sessionDir)) {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
      }
      const metaPath = this.getSessionMetaPath(sessionId);
      if (fs.existsSync(metaPath)) {
        await fs.promises.unlink(metaPath).catch(() => {});
      }
    } catch {
      // Safe teardown, ignore missing directory
    }
  }

  /**
   * Backward-compatible alias for disposeSession.
   */
  public async cleanupSession(sessionId: string): Promise<void> {
    return this.disposeSession(sessionId);
  }

  /**
   * Cleans stale session directories left by past crashes or abandoned runs.
   * Skips active and retained sessions.
   * @param maxAgeMs Maximum session directory age in ms (default: 1 hour)
   */
  public async cleanStaleSessions(maxAgeMs = 3600000): Promise<number> {
    if (this.cleanedStale) return 0;
    this.cleanedStale = true;

    let cleanedCount = 0;
    try {
      if (!fs.existsSync(this.baseDir)) return 0;
      const entries = await fs.promises.readdir(this.baseDir, {
        withFileTypes: true,
      });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionId = entry.name;
          // Never clean protected active or retained sessions
          if (this.isSessionProtected(sessionId)) {
            continue;
          }

          const dirPath = path.join(this.baseDir, sessionId);
          try {
            const stat = await fs.promises.stat(dirPath);
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.promises.rm(dirPath, { recursive: true, force: true });
              const metaPath = this.getSessionMetaPath(sessionId);
              if (fs.existsSync(metaPath)) {
                await fs.promises.unlink(metaPath).catch(() => {});
              }
              cleanedCount++;
            }
          } catch {
            // Ignore individual directory stat/rm errors
          }
        }
      }
    } catch {
      // Safe no-op on read failure
    }
    return cleanedCount;
  }
}
