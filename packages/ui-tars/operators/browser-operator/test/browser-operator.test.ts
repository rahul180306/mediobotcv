/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocalBrowser } from '@agent-infra/browser';
import type { Page } from '@agent-infra/browser';
import { BrowserOperator } from '../src/browser-operator';
import type { ExecuteParams } from '../src/types';

describe('UI-TARS Original BrowserOperator Execution & Clean DOM Suite', () => {
  let localBrowser: LocalBrowser;
  let page: Page;
  let operator: BrowserOperator;

  beforeAll(async () => {
    localBrowser = new LocalBrowser();
    await localBrowser.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
    });
    page = await localBrowser.getActivePage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

    operator = new BrowserOperator({
      browser: localBrowser,
      browserType: 'chrome',
    });
  }, 30000);

  afterAll(async () => {
    if (localBrowser) {
      await localBrowser.close();
    }
  });

  // ========================================================================
  // Test 1: Ordinary Click Execution without Black Screen / Coordinate Overlay
  // ========================================================================
  it('executes ordinary mouse click and produces NO black screen or coordinate overlay', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 50px;">
          <button id="main-btn" style="width: 200px; height: 50px; font-size: 16px;">
            Action Button
          </button>
          <script>
            window.__clickCount = 0;
            document.getElementById('main-btn').addEventListener('click', () => {
              window.__clickCount++;
            });
          </script>
        </body>
      </html>
    `);

    // Button occupies [50, 50] to [250, 100]. Center is (150, 75).
    const params: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: {
          start_coords: [150, 75],
        },
        thought: 'Click the Action Button',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    const result = await operator.execute(params);

    // Verify click event received
    const clickCount = await page.evaluate(() => (window as any).__clickCount);
    expect(clickCount).toBe(1);

    // Verify coordinates returned directly
    expect(result.startX).toBe(150);
    expect(result.startY).toBe(75);

    // Verify NO black-screen helper container injected
    const helperContainer = await page.$('#gui-agent-helper-container');
    expect(helperContainer).toBeNull();

    // Verify NO coordinate text overlay injected into DOM
    const coordsOverlay = await page.$('.gui-agent-coords');
    expect(coordsOverlay).toBeNull();

    // Verify NO grounded decision property exists on operator or output
    expect((result as any).groundingDecision).toBeUndefined();
    expect((result as any).groundingReport).toBeUndefined();
    expect((operator as any).enableGroundedClicks).toBeUndefined();
  });

  // ========================================================================
  // Test 2: Double Click Execution
  // ========================================================================
  it('executes ordinary double-click accurately', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 50px;">
          <div id="dbl-box" style="width: 200px; height: 50px; background: #eee;">
            Double Click Area
          </div>
          <script>
            window.__dblCount = 0;
            document.getElementById('dbl-box').addEventListener('dblclick', () => {
              window.__dblCount++;
            });
          </script>
        </body>
      </html>
    `);

    const params: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'double_click',
        action_inputs: {
          start_coords: [150, 75],
        },
        thought: 'Double click the area',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    await operator.execute(params);

    const dblCount = await page.evaluate(() => (window as any).__dblCount);
    expect(dblCount).toBe(1);
  });

  // ========================================================================
  // Test 3: Typing Execution with Enter Key Submission
  // ========================================================================
  it('executes typing and enter submission correctly while rejecting empty content', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 50px;">
          <input id="test-input" style="width: 300px; height: 40px;" />
          <script>
            window.__submitted = false;
            const input = document.getElementById('test-input');
            input.focus();
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                window.__submitted = true;
              }
            });
          </script>
        </body>
      </html>
    `);

    // Focus the input first
    await page.focus('#test-input');

    // Type with Enter key
    const typeParams: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'type',
        action_inputs: {
          content: 'hello world\n',
        },
        thought: 'Type query and press Enter',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    await operator.execute(typeParams);

    const inputValue = await page.evaluate(
      () => (document.getElementById('test-input') as HTMLInputElement).value,
    );
    const submitted = await page.evaluate(() => (window as any).__submitted);

    expect(inputValue).toBe('hello world');
    expect(submitted).toBe(true);

    // Negative test: verify empty typing content returns execution failure
    const emptyParams: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'type',
        action_inputs: {},
        thought: 'Empty typing',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    await expect(operator.execute(emptyParams)).rejects.toThrow(
      /No content to type/i,
    );
  });

  // ========================================================================
  // Test 4: Page Scrolling Execution
  // ========================================================================
  it('executes scroll down and up correctly', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 0; height: 4000px;">
          <div style="height: 2000px;">Top Section</div>
          <div id="bottom-marker">Bottom Section</div>
        </body>
      </html>
    `);

    const scrollParams: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'scroll',
        action_inputs: {
          direction: 'down',
        },
        thought: 'Scroll down to see more content',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    await operator.execute(scrollParams);

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
  });

  // ========================================================================
  // Test 5: Page Navigation
  // ========================================================================
  it('executes page navigation correctly', async () => {
    const navParams: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: {
          content:
            'data:text/html,<html><body><h1 id="title">Navigated</h1></body></html>',
        },
        thought: 'Navigate to target page',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    await operator.execute(navParams);

    const headingText = await page.evaluate(
      () => document.getElementById('title')?.textContent,
    );
    expect(headingText).toBe('Navigated');
  });

  // ========================================================================
  // Test 6: Retina Coordinate Scaling (DPR = 2) without Grounding Interception
  // ========================================================================
  it('scales physical coordinates to CSS coordinates correctly in Retina mode', async () => {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 40px;">
          <button id="retina-btn" style="width: 140px; height: 44px;">
            Retina Click
          </button>
          <script>
            window.__retinaClicked = 0;
            document.getElementById('retina-btn').addEventListener('click', () => {
              window.__retinaClicked++;
            });
          </script>
        </body>
      </html>
    `);

    // In CSS pixels, button center is (110, 62).
    // In physical pixels (scaleFactor=2), coordinates are (220, 124).
    const retinaParams: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: {
          start_coords: [220, 124],
        },
        thought: 'Click button on Retina display',
        reflection: null,
      },
      screenWidth: 2560,
      screenHeight: 1600,
      scaleFactor: 2,
      factors: [1, 1],
    };

    const result = await operator.execute(retinaParams);

    // Scaled CSS pixels executed
    expect(result.startX).toBe(110);
    expect(result.startY).toBe(62);

    const count = await page.evaluate(() => (window as any).__retinaClicked);
    expect(count).toBe(1);

    // Clean up viewport
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  });

  // ========================================================================
  // Test 7: Disabled / Occluded Elements receive standard browser mouse events (No interception)
  // ========================================================================
  it('executes original mouse click without grounded-clicking interception on disabled elements', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 0; padding: 50px;">
          <button id="disabled-btn" disabled style="width: 150px; height: 40px;">
            Disabled Button
          </button>
          <script>
            window.__mousedownCount = 0;
            document.getElementById('disabled-btn').addEventListener('mousedown', () => {
              window.__mousedownCount++;
            });
          </script>
        </body>
      </html>
    `);

    const params: ExecuteParams = {
      prediction: '',
      parsedPrediction: {
        action_type: 'click',
        action_inputs: {
          start_coords: [100, 70],
        },
        thought: 'Click disabled button',
        reflection: null,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };

    // In original UI-TARS, mouse click executes at coordinates without throwing a grounding error
    await expect(operator.execute(params)).resolves.toBeDefined();
  });
});
