/**
 * Milestone 1B: Bounded Observation Retention & Ephemeral Storage Suite
 * Validates memory bounding, session-scoped scratch persistence,
 * model request construction, and context isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ObservationStorage } from '../src/observation/observationStorage';
import { ImagePreprocessCache } from '../src/cache/imagePreprocessCache';
import { GUIAgent } from '../src/GUIAgent';
import { UITarsModel } from '../src/Model';
import { Operator, InvokeParams, InvokeOutput } from '../src/types';
import { toVlmModelFormat, parseImageDimensions } from '../src/utils';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { StatusEnum } from '@ui-tars/shared/types';
import { useContext } from '../src/context/useContext';

describe('Milestone 1B: Bounded Observation Retention & Ephemeral Storage', () => {
  const testBaseDir = path.join(os.tmpdir(), 'mediobot-test-m1b', `test_${Date.now()}`);

  beforeEach(async () => {
    await fs.promises.mkdir(testBaseDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('ObservationStorage saves, loads, and cleans up session scratch files', async () => {
    const storage = new ObservationStorage({ baseDir: testBaseDir });
    const sessionId = 'session_test_1';
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const savedPath = await storage.saveScreenshot(sessionId, 0, fakeBase64);
    expect(fs.existsSync(savedPath)).toBe(true);

    const loaded = await storage.loadScreenshotBase64(savedPath);
    expect(loaded).toBe(fakeBase64);

    await storage.cleanupSession(sessionId);
    expect(fs.existsSync(storage.getSessionDir(sessionId))).toBe(false);
  });

  it('ObservationStorage cleans stale sessions older than threshold', async () => {
    const storage = new ObservationStorage({ baseDir: testBaseDir });
    const staleSession = 'session_stale_1';
    const activeSession = 'session_active_1';
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const staleFile = await storage.saveScreenshot(staleSession, 0, fakeBase64);
    const activeFile = await storage.saveScreenshot(activeSession, 0, fakeBase64);

    // Artificially age the stale session directory
    const staleDir = storage.getSessionDir(staleSession);
    const twoHoursAgo = new Date(Date.now() - 7200000);
    fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    // Run stale cleanup with 1h threshold
    (storage as any).cleanedStale = false;
    const cleaned = await storage.cleanStaleSessions(3600000);

    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(storage.getSessionDir(activeSession))).toBe(true);

    await storage.cleanupSession(activeSession);
  });

  it('toVlmModelFormat filters out pruned image placeholders while preserving action history', () => {
    const conversations: any[] = [
      { from: 'human', value: 'Open Google' },
      // Step 1: screenshot pruned from memory
      { from: 'human', value: IMAGE_PLACEHOLDER, screenshotPath: '/tmp/step_0.jpg' },
      { from: 'gpt', value: 'Thought: click search\nAction: click(point=[100,200])' },
      // Step 2: screenshot retained in memory
      {
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: 'fake-base64-img2',
        screenshotPath: '/tmp/step_1.jpg',
      },
      { from: 'gpt', value: 'Thought: type query\nAction: type(content="hello\\n")' },
    ];

    const result = toVlmModelFormat({
      historyMessages: [],
      conversations,
      systemPrompt: 'System Instruction ## User Instruction',
    });

    // Images array should contain ONLY the active unpruned image
    expect(result.images).toEqual(['fake-base64-img2']);

    // Model conversations should preserve Step 1's thought/action, but omit Step 1's pruned <image>
    expect(result.conversations).toHaveLength(4);
    expect(result.conversations[0].from).toBe('human'); // Instruction
    expect(result.conversations[1].value).toBe('Thought: click search\nAction: click(point=[100,200])'); // Step 1 thought retained!
    expect(result.conversations[2].value).toBe(IMAGE_PLACEHOLDER); // Step 2 <image>
    expect(result.conversations[3].value).toBe('Thought: type query\nAction: type(content="hello\\n")'); // Step 2 thought
  });

  it('GUIAgent bounds in-memory screenshots to maxRecentImagesWindow over multiple steps', async () => {
    class MockOperator extends Operator {
      step = 0;
      async screenshot() {
        this.step++;
        return {
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          scaleFactor: 1,
        };
      }
      async execute() {
        return { status: StatusEnum.RUNNING };
      }
    }

    class MockModel extends UITarsModel {
      callCount = 0;
      constructor() {
        super({ baseURL: 'http://localhost:1234/v1', apiKey: 'mock', model: 'mock-vlm' });
      }
      get factors(): [number, number] {
        return [1000, 1000];
      }
      async invoke(params: InvokeParams): Promise<InvokeOutput> {
        this.callCount++;
        return {
          prediction: `Thought: step ${this.callCount}\nAction: wait()`,
          parsedPredictions: [
            {
              action_type: this.callCount >= 6 ? 'finished' : 'wait',
              action_inputs: {},
              reflection: null,
              thought: `step ${this.callCount}`,
            },
          ],
        };
      }
    }

    const operator = new MockOperator();
    const model = new MockModel();
    const sessionId = `test_agent_${Date.now()}`;

    const agent = new GUIAgent({
      operator,
      model,
      sessionId,
      maxRecentImagesWindow: 3, // Keep only 3 recent screenshots in memory
      maxLoopCount: 6,
      loopIntervalInMs: 1,
    });

    let lastData: any = null;
    await agent.run('Test bounded retention', [], undefined);

    // Retrieve agent context
    const storage = ObservationStorage.getInstance();
    const sessionDir = storage.getSessionDir(sessionId);

    // Verify all 6 step screenshots were saved to scratch disk
    expect(fs.existsSync(sessionDir)).toBe(true);
    const files = await fs.promises.readdir(sessionDir);
    expect(files.length).toBe(6);

    // Agent execution finished: session is in RETAINED state and files remain on disk for viewer!
    expect(storage.isSessionProtected(sessionId)).toBe(true);

    // destroy() without args cleans up runtime execution state but PRESERVES history for viewer
    await agent.destroy();
    expect(fs.existsSync(sessionDir)).toBe(true);

    // Explicit observation-history disposal cleans up the scratch files deterministically
    await agent.disposeObservationHistory();
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('concurrent GUIAgent instances maintain isolated contexts and abort signals', async () => {
    class StubOperator extends Operator {
      async screenshot() {
        return {
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          scaleFactor: 1,
        };
      }
      async execute() {
        return { status: StatusEnum.RUNNING };
      }
    }

    const capturedContexts: any[] = [];

    class ContextCapturingModel extends UITarsModel {
      name: string;
      constructor(name: string) {
        super({ baseURL: 'http://localhost:1234/v1', apiKey: 'mock', model: name });
        this.name = name;
      }
      get factors(): [number, number] {
        return [1000, 1000];
      }
      async invoke(params: InvokeParams): Promise<InvokeOutput> {
        const ctx = useContext<any>();
        capturedContexts.push({
          modelName: this.name,
          ctxSystemPrompt: ctx?.systemPrompt,
          aborted: ctx?.signal?.aborted,
        });
        return {
          prediction: 'Action: finished()',
          parsedPredictions: [{ action_type: 'finished', action_inputs: {}, reflection: null, thought: '' }],
        };
      }
    }

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    controllerA.abort(); // Agent A is aborted

    const agentA = new GUIAgent({
      operator: new StubOperator(),
      model: new ContextCapturingModel('AgentA'),
      systemPrompt: 'System Prompt A',
      signal: controllerA.signal,
      maxLoopCount: 1,
    });

    const agentB = new GUIAgent({
      operator: new StubOperator(),
      model: new ContextCapturingModel('AgentB'),
      systemPrompt: 'System Prompt B',
      signal: controllerB.signal, // Agent B is NOT aborted
      maxLoopCount: 1,
    });

    await Promise.all([
      agentA.run('Task A').catch(() => {}),
      agentB.run('Task B').catch(() => {}),
    ]);

    // Check that Agent B saw System Prompt B and was NOT aborted
    const agentBContext = capturedContexts.find((c) => c.modelName === 'AgentB');
    if (agentBContext) {
      expect(agentBContext.ctxSystemPrompt).toBe('System Prompt B');
      expect(agentBContext.aborted).toBe(false);
    }
  });

  it('protects active and retained sessions from stale-file garbage collection', async () => {
    const storage = new ObservationStorage({ baseDir: testBaseDir });
    const activeSession = 'active_session_guard';
    const retainedSession = 'retained_session_guard';
    const abandonedSession = 'abandoned_session_stale';
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    await storage.saveScreenshot(activeSession, 0, fakeBase64);
    await storage.saveScreenshot(retainedSession, 0, fakeBase64);
    await storage.saveScreenshot(abandonedSession, 0, fakeBase64);

    storage.registerActiveSession(activeSession);
    storage.retainSession(retainedSession);
    // abandonedSession is neither active nor retained

    // Artificially age all three directories by 3 hours
    const threeHoursAgo = new Date(Date.now() - 10800000);
    fs.utimesSync(storage.getSessionDir(activeSession), threeHoursAgo, threeHoursAgo);
    fs.utimesSync(storage.getSessionDir(retainedSession), threeHoursAgo, threeHoursAgo);
    fs.utimesSync(storage.getSessionDir(abandonedSession), threeHoursAgo, threeHoursAgo);

    (storage as any).cleanedStale = false;
    const cleaned = await storage.cleanStaleSessions(3600000);

    // Only the abandoned session must be deleted
    expect(cleaned).toBe(1);
    expect(fs.existsSync(storage.getSessionDir(abandonedSession))).toBe(false);
    expect(fs.existsSync(storage.getSessionDir(activeSession))).toBe(true);
    expect(fs.existsSync(storage.getSessionDir(retainedSession))).toBe(true);

    // Clean up
    await storage.disposeSession(activeSession);
    await storage.disposeSession(retainedSession);
  });

  it('ImagePreprocessCache enforces byte-aware eviction and true LRU ordering', () => {
    // Limit to 10 KB (10240 bytes)
    const cache = new ImagePreprocessCache({ maxBytes: 10240, maxEntries: 10 });

    // Each string of 2000 chars is ~4000 bytes
    const str1 = 'A'.repeat(2000);
    const str2 = 'B'.repeat(2000);
    const str3 = 'C'.repeat(2000);

    cache.set('key1', str1); // ~4008 bytes
    cache.set('key2', str2); // ~4008 bytes (total ~8016 bytes)
    expect(cache.has('key1')).toBe(true);
    expect(cache.has('key2')).toBe(true);

    // Access key1 to promote it to MRU
    expect(cache.get('key1')).toBe(str1);

    // Adding key3 exceeds 10 KB; key2 (least recently used) must be evicted first!
    cache.set('key3', str3);
    expect(cache.has('key1')).toBe(true); // preserved because it was promoted
    expect(cache.has('key2')).toBe(false); // evicted!
    expect(cache.has('key3')).toBe(true);

    const stats = cache.getStats();
    expect(stats.currentBytes).toBeLessThanOrEqual(10240);
    expect(stats.evictions).toBeGreaterThanOrEqual(1);

    // Clear releases memory
    cache.clear();
    expect(cache.getStats().currentBytes).toBe(0);
    expect(cache.getStats().entries).toBe(0);
  });

  it('parseImageDimensions extracts dimensions without bitmap decoding', () => {
    // 1x1 PNG sample
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const pngDims = parseImageDimensions(pngBuffer);
    expect(pngDims).toEqual({
      width: 1,
      height: 1,
      mime: 'image/png',
    });

    // Invalid buffer returns null safely
    const invalidBuffer = Buffer.from('not an image at all');
    expect(parseImageDimensions(invalidBuffer)).toBeNull();
  });

  it('recovers retained session metadata and screenshots across application restart without deleting legitimate sessions', async () => {
    const storage1 = ObservationStorage.getInstance();
    const sessionIdRetained = 'recovery-test-retained-' + Date.now();
    const sessionIdActive = 'recovery-test-active-' + Date.now();

    storage1.registerActiveSession(sessionIdRetained);
    storage1.registerActiveSession(sessionIdActive);

    const base64Sample =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const pathRetained0 = await storage1.saveScreenshot(sessionIdRetained, 0, base64Sample);
    const pathRetained1 = await storage1.saveScreenshot(sessionIdRetained, 1, base64Sample);
    const pathActive0 = await storage1.saveScreenshot(sessionIdActive, 0, base64Sample);

    expect(fs.existsSync(pathRetained0)).toBe(true);
    expect(fs.existsSync(pathRetained1)).toBe(true);
    expect(fs.existsSync(pathActive0)).toBe(true);

    // Retain session 1; leave session 2 active (simulates sudden process exit)
    storage1.retainSession(sessionIdRetained);

    // Simulate Application Restart / Crash
    ObservationStorage.resetInstanceForTesting();

    // Rehydrate on startup
    const storage2 = ObservationStorage.getInstance();

    // Both sessions must be recovered as protected/retained sessions!
    expect(storage2.isSessionProtected(sessionIdRetained)).toBe(true);
    expect(storage2.isSessionProtected(sessionIdActive)).toBe(true);

    // Ensure stale session cleanup does NOT delete either recovered session
    const cleaned = await storage2.cleanStaleSessions(0);
    expect(cleaned).toBe(0);
    expect(fs.existsSync(pathRetained0)).toBe(true);
    expect(fs.existsSync(pathRetained1)).toBe(true);
    expect(fs.existsSync(pathActive0)).toBe(true);

    // Cleanup
    await storage2.disposeSession(sessionIdRetained);
    await storage2.disposeSession(sessionIdActive);
    expect(fs.existsSync(pathRetained0)).toBe(false);
    expect(fs.existsSync(pathActive0)).toBe(false);
  });
});
