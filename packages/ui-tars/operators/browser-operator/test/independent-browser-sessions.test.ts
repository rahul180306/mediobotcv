/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { LocalBrowser } from '@agent-infra/browser';
import { BrowserOperator, DefaultBrowserOperator } from '../src/browser-operator';
import type { ExecuteParams } from '../src/types';

describe('Milestone 1A: Independent Browser Sessions & Concurrency Suite', () => {
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;

  let localBrowser: LocalBrowser;
  let operatorA: BrowserOperator;
  let operatorB: BrowserOperator;

  // Tiny local HTTP server to host real pages with cookies, localStorage, popups, and click targets
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url || '/';

      if (url.startsWith('/session-a')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Page A</title></head>
            <body style="margin: 0; padding: 40px; background: #e0f7fa;">
              <h1 id="header-a">Session A Page</h1>
              <input id="input-a" type="text" placeholder="Input for A" />
              <button id="btn-a" style="width: 100px; height: 40px;">Button A</button>
              <a id="popup-link-a" href="/popup-a" target="_blank">Open Popup A</a>
              <script>
                window.__clickCountA = 0;
                document.getElementById('btn-a').addEventListener('click', () => {
                  window.__clickCountA++;
                });
              </script>
            </body>
          </html>
        `);
      } else if (url.startsWith('/session-b')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Page B</title></head>
            <body style="margin: 0; padding: 40px; background: #fff3e0;">
              <h1 id="header-b">Session B Page</h1>
              <input id="input-b" type="text" placeholder="Input for B" />
              <button id="btn-b" style="width: 100px; height: 40px;">Button B</button>
              <script>
                window.__clickCountB = 0;
                document.getElementById('btn-b').addEventListener('click', () => {
                  window.__clickCountB++;
                });
              </script>
            </body>
          </html>
        `);
      } else if (url.startsWith('/popup-a')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Popup A</title></head>
            <body style="padding: 20px;">
              <h2 id="popup-header">Popup Window Owned By Session A</h2>
            </body>
          </html>
        `);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>Home</h1></body></html>');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // Launch a single managed LocalBrowser daemon
    localBrowser = new LocalBrowser();
    await localBrowser.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
    });

    // Create two independent BrowserContextSession instances sharing the same Chromium daemon
    const sessionA = await localBrowser.createSession({
      defaultViewport: { width: 1280, height: 800 },
    });
    const sessionB = await localBrowser.createSession({
      defaultViewport: { width: 1280, height: 800 },
    });

    operatorA = new BrowserOperator({
      browser: sessionA,
      browserType: 'chrome',
    });

    operatorB = new BrowserOperator({
      browser: sessionB,
      browserType: 'chrome',
    });
  }, 35000);

  afterAll(async () => {
    if (operatorA) {
      await operatorA.destroy().catch(() => {});
    }
    if (operatorB) {
      await operatorB.destroy().catch(() => {});
    }
    if (localBrowser) {
      await localBrowser.close().catch(() => {});
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ========================================================================
  // Test 1: Navigation Isolation
  // ========================================================================
  it('navigates two sessions to different URLs without cross-session interference', async () => {
    // Navigate operator A to /session-a
    await operatorA.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: { content: `${baseUrl}/session-a` },
        thought: 'Navigate session A',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    // Navigate operator B to /session-b
    await operatorB.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: { content: `${baseUrl}/session-b` },
        thought: 'Navigate session B',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    // Verify session A is on /session-a
    const pageA = await (operatorA as any).getActivePage();
    const titleA = await pageA.title();
    const urlA = await pageA.url();
    expect(titleA).toBe('Page A');
    expect(urlA).toContain('/session-a');

    // Verify session B is on /session-b
    const pageB = await (operatorB as any).getActivePage();
    const titleB = await pageB.title();
    const urlB = await pageB.url();
    expect(titleB).toBe('Page B');
    expect(urlB).toContain('/session-b');
  });

  // ========================================================================
  // Test 2: Cookie & Local Storage Isolation
  // ========================================================================
  it('isolates cookies and local storage between the two sessions', async () => {
    const pageA = await (operatorA as any).getActivePage();
    const pageB = await (operatorB as any).getActivePage();

    // Set cookie and localStorage in Session A
    await pageA.evaluate(() => {
      document.cookie = 'user_id=alice_secret_token; path=/';
      localStorage.setItem('auth_key', 'token_for_alice');
    });

    // Verify Session A sees its own data
    const cookieInA = await pageA.evaluate(() => document.cookie);
    const storageInA = await pageA.evaluate(() => localStorage.getItem('auth_key'));
    expect(cookieInA).toContain('alice_secret_token');
    expect(storageInA).toBe('token_for_alice');

    // Verify Session B has NONE of Session A's cookies or localStorage
    const cookieInB = await pageB.evaluate(() => document.cookie);
    const storageInB = await pageB.evaluate(() => localStorage.getItem('auth_key'));
    expect(cookieInB).not.toContain('alice_secret_token');
    expect(storageInB).toBeNull();

    // Set distinctive cookie in Session B
    await pageB.evaluate(() => {
      document.cookie = 'user_id=bob_isolated_token; path=/';
      localStorage.setItem('auth_key', 'token_for_bob');
    });

    // Verify Session B has Bob's data and Session A has Alice's data unchanged
    expect(await pageB.evaluate(() => document.cookie)).toContain('bob_isolated_token');
    expect(await pageB.evaluate(() => localStorage.getItem('auth_key'))).toBe('token_for_bob');

    expect(await pageA.evaluate(() => document.cookie)).toContain('alice_secret_token');
    expect(await pageA.evaluate(() => localStorage.getItem('auth_key'))).toBe('token_for_alice');
  });

  // ========================================================================
  // Test 3: Concurrent Action Execution
  // ========================================================================
  it('executes actions concurrently across both operators without lock contention', async () => {
    const pageA = await (operatorA as any).getActivePage();
    const pageB = await (operatorB as any).getActivePage();

    // Reset counts
    await pageA.evaluate(() => { (window as any).__clickCountA = 0; });
    await pageB.evaluate(() => { (window as any).__clickCountB = 0; });

    // Button A center is roughly (90, 100), Button B center is roughly (90, 100)
    const btnBoxA = await pageA.evaluate(() => {
      const rect = document.getElementById('btn-a')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });
    const btnBoxB = await pageB.evaluate(() => {
      const rect = document.getElementById('btn-b')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });

    expect(btnBoxA).not.toBeNull();
    expect(btnBoxB).not.toBeNull();

    const actionA = operatorA.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: { start_coords: [btnBoxA!.x, btnBoxA!.y] },
        thought: 'Click Button A',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    const actionB = operatorB.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: { start_coords: [btnBoxB!.x, btnBoxB!.y] },
        thought: 'Click Button B',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    // Wait for both concurrent executions to complete
    await Promise.all([actionA, actionB]);

    const countA = await pageA.evaluate(() => (window as any).__clickCountA);
    const countB = await pageB.evaluate(() => (window as any).__clickCountB);

    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  // ========================================================================
  // Test 4: Popup Handling and Target Isolation
  // ========================================================================
  it('keeps popups strictly owned by the originating session without hijacking other sessions', async () => {
    const pageB = await (operatorB as any).getActivePage();
    const originalUrlB = await pageB.url();

    // In Session A, click the popup link that opens target="_blank"
    const pageA = await (operatorA as any).getActivePage();
    const popupLinkCoords = await pageA.evaluate(() => {
      const rect = document.getElementById('popup-link-a')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });

    expect(popupLinkCoords).not.toBeNull();

    await operatorA.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: { start_coords: [popupLinkCoords!.x, popupLinkCoords!.y] },
        thought: 'Click popup link in Session A',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    // Wait for popup target to register in Session A
    await new Promise((r) => setTimeout(r, 600));

    // Session A active page should now be the popup
    const activePageA = await (operatorA as any).getActivePage();
    const activeUrlA = await activePageA.url();
    expect(activeUrlA).toContain('/popup-a');

    // Session B active page MUST REMAIN Session B's page
    const activePageB = await (operatorB as any).getActivePage();
    const activeUrlB = await activePageB.url();
    expect(activeUrlB).toBe(originalUrlB);
    expect(activeUrlB).not.toContain('/popup-a');

    // Close the popup in Session A
    await activePageA.close();
    await new Promise((r) => setTimeout(r, 300));

    // Session A active page should revert back to /session-a
    const revertedPageA = await (operatorA as any).getActivePage();
    expect(await revertedPageA.url()).toContain('/session-a');

    // Session B remains completely intact
    expect(await (operatorB as any).getActivePage().then((p: any) => p.url())).toContain('/session-b');
  });

  // ========================================================================
  // Test 5: Distinct Screenshot Capture
  // ========================================================================
  it('captures screenshots corresponding strictly to each session own page', async () => {
    const screenshotA = await operatorA.screenshot();
    const screenshotB = await operatorB.screenshot();

    expect(screenshotA.base64).toBeDefined();
    expect(screenshotB.base64).toBeDefined();

    // The screenshots of two visually distinct pages must not be identical strings
    expect(screenshotA.base64).not.toBe(screenshotB.base64);
  });

  // ========================================================================
  // Test 6: Failure & Closing Resilience
  // ========================================================================
  it('closing one session leaves the other session completely functional', async () => {
    // Destroy Session A completely
    await operatorA.destroy();

    // Session A should now throw if actions are attempted
    await expect(
      operatorA.execute({
        prediction: '',
        parsedPrediction: {
          action_type: 'click',
          action_inputs: { start_coords: [100, 100] },
          thought: 'Try click on dead session A',
          reflection: null,
        },
        screenWidth: 1280,
        screenHeight: 800,
        scaleFactor: 1,
        factors: [1, 1],
      }),
    ).rejects.toThrow();

    // Session B MUST still be 100% alive, capable of typing and clicking
    const pageB = await (operatorB as any).getActivePage();
    expect(pageB).toBeDefined();

    // Focus input B before typing
    await pageB.focus('#input-b');

    // Execute typing in Session B
    await operatorB.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'type',
        action_inputs: { content: 'Testing Session B Resiliency' },
        thought: 'Type into input B after session A closed',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    const inputValue = await pageB.evaluate(
      () => (document.getElementById('input-b') as HTMLInputElement)?.value,
    );
    expect(inputValue).toBe('Testing Session B Resiliency');

    // Root browser must still be connected
    expect(localBrowser.getBrowser().isConnected()).toBe(true);
  });

  // ========================================================================
  // Test 7: DefaultBrowserOperator.createIsolatedSession Integration
  // ========================================================================
  it('supports DefaultBrowserOperator.createIsolatedSession factory with clean lifecycle', async () => {
    const isoOp1 = await DefaultBrowserOperator.createIsolatedSession();
    const isoOp2 = await DefaultBrowserOperator.createIsolatedSession();

    expect(isoOp1).not.toBe(isoOp2);

    await isoOp1.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: { content: `${baseUrl}/session-a` },
        thought: 'Nav iso 1',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    await isoOp2.execute({
      prediction: '',
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: { content: `${baseUrl}/session-b` },
        thought: 'Nav iso 2',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    });

    const p1 = await (isoOp1 as any).getActivePage();
    const p2 = await (isoOp2 as any).getActivePage();

    expect(await p1.url()).toContain('/session-a');
    expect(await p2.url()).toContain('/session-b');

    // Clean up both isolated operators
    await isoOp1.destroy();
    await isoOp2.destroy();
  });
});
