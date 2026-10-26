/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LocalBrowser } from '@agent-infra/browser';
import type { Page } from '@agent-infra/browser';
import { BrowserOperator } from '../src/browser-operator';
import { IntermediateProgressStatus } from '../src/verification';
import type { ExecuteParams, IntermediateStateContract } from '../src/types';

describe('Milestone 2: Intent-Aware Intermediate-State Verification (Chromium)', () => {
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

  beforeEach(async () => {
    // Reset trackers and clear page to prevent test cross-contamination
    operator.getActionVerifier().reset();
    operator.getTaskStateTracker().clear();
    await page.goto('about:blank');
  });

  // ── Helper ───────────────────────────────────────────────────────────────
  function clickAt(x: number, y: number, thought = 'click'): ExecuteParams {
    return {
      prediction: `Action: click(start_box='[${x - 5}, ${y - 5}, ${x + 5}, ${y + 5}]')`,
      parsedPrediction: {
        action_type: 'click',
        action_inputs: { start_coords: [x, y] },
        reflection: null,
        thought,
      },
      screenWidth: 1280,
      screenHeight: 800,
    };
  }

  function scrollDown(thought = 'scroll', x = 250, y = 200): ExecuteParams {
    return {
      prediction: `Action: scroll(direction='down')`,
      parsedPrediction: {
        action_type: 'scroll',
        action_inputs: { direction: 'down', start_coords: [x, y] },
        reflection: null,
        thought,
      },
      screenWidth: 1280,
      screenHeight: 800,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test 1: Successful milestone (REACHED)
  // ══════════════════════════════════════════════════════════════════════════
  it('recognizes a successfully reached milestone with URL and semantic criteria', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <button id="search-btn" style="position:fixed;left:50px;top:50px;width:200px;height:50px;">Search Products</button>
      <div id="results" style="position:fixed;left:50px;top:120px;"></div>
      <script>
        document.getElementById('search-btn').addEventListener('click', () => {
          location.hash = '#/search';
          document.getElementById('results').innerHTML =
            '<h2>Search Results</h2><ul><li role="listitem">Product Alpha</li><li role="listitem">Product Beta</li></ul>';
        });
      </script>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-search-results',
      expectedMilestone: 'Product search results rendered',
      evaluationCriteria: {
        urlPattern: '#/search',
        requiredSemanticElements: ['Search Results', 'Product Alpha'],
        minimumItemCount: 2,
      },
    };

    operator.setIntermediateMilestone(milestone);

    const out = await operator.execute(clickAt(150, 75, 'click search button'));

    expect(out.intermediateState).toBeDefined();
    expect(out.intermediateState?.status).toBe(IntermediateProgressStatus.REACHED);
    expect(out.intermediateState?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(out.intermediateState?.feedback).toContain('REACHED');
    expect(out.intermediateState?.feedback).toContain('Product search results rendered');
    expect(out.intermediateState?.evidence.currentUrl).toContain('#/search');
    expect(out.intermediateState?.evidence.isStalled).toBe(false);

    // Verify tracker marked milestone completed
    expect(operator.getTaskStateTracker().getCompletedMilestones()).toContain(
      'milestone-search-results',
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 2: Wrong navigation deviation (BLOCKED)
  // ══════════════════════════════════════════════════════════════════════════
  it('detects navigation deviation to forbidden or error URL and reports BLOCKED', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <button id="err-btn" style="position:fixed;left:50px;top:50px;width:200px;height:50px;">Go to Admin</button>
      <script>
        document.getElementById('err-btn').addEventListener('click', () => {
          location.hash = '#/error-404-not-found';
        });
      </script>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-admin-settings',
      expectedMilestone: 'Admin settings panel displayed',
      evaluationCriteria: {
        urlPattern: '#/admin',
        forbiddenUrlPatterns: ['error', '404'],
      },
    };

    operator.setIntermediateMilestone(milestone);

    const out = await operator.execute(clickAt(150, 75, 'click admin button'));

    expect(out.intermediateState).toBeDefined();
    expect(out.intermediateState?.status).toBe(IntermediateProgressStatus.BLOCKED);
    expect(out.intermediateState?.evidence.deviationDetected).toBe(true);
    expect(out.intermediateState?.evidence.deviationReason).toBeDefined();
    expect(out.intermediateState?.feedback).toContain('BLOCKED');
    expect(out.intermediateState?.feedback).toContain('deviated');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 3: Delayed completion / Active loading state (IN_PROGRESS)
  // ══════════════════════════════════════════════════════════════════════════
  it('handles delayed async loading states as IN_PROGRESS without false failure', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <button id="fetch-btn" style="position:fixed;left:50px;top:50px;width:200px;height:50px;">Load Big Data</button>
      <div id="loader" style="display:none;position:fixed;left:50px;top:120px;" class="spinner" role="progressbar">Loading report...</div>
      <script>
        document.getElementById('fetch-btn').addEventListener('click', () => {
          document.body.setAttribute('aria-busy', 'true');
          document.getElementById('loader').style.display = 'block';
        });
      </script>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-report-loaded',
      expectedMilestone: 'Analytics report data loaded',
      evaluationCriteria: {
        requiredSemanticElements: ['Completed Report', 'Data Matrix'],
      },
    };

    operator.setIntermediateMilestone(milestone);

    const out = await operator.execute(clickAt(150, 75, 'trigger report load'));

    expect(out.intermediateState).toBeDefined();
    expect(out.intermediateState?.status).toBe(IntermediateProgressStatus.IN_PROGRESS);
    expect(out.intermediateState?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(out.intermediateState?.feedback).toContain('IN_PROGRESS');
    expect(out.intermediateState?.feedback).toContain('actively loading');
    // Active loading must NOT count as a stalled action
    expect(out.intermediateState?.evidence.consecutiveNoProgressCount).toBe(0);
    expect(out.intermediateState?.evidence.isStalled).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 4: Blocked interactions (Modal / Dialog overlay)
  // ══════════════════════════════════════════════════════════════════════════
  it('detects blocking modal dialog and returns BLOCKED with overlay guidance', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <button id="next-step" style="position:fixed;left:50px;top:50px;width:200px;height:50px;">Proceed to Payment</button>
      <dialog id="consent-modal" open role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;width:300px;height:150px;background:#fff;border:2px solid red;">
        <h3>Consent Required</h3>
        <p>You must accept terms before proceeding.</p>
        <button id="accept-btn">Accept Terms</button>
      </dialog>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-payment-page',
      expectedMilestone: 'Payment options screen displayed',
      evaluationCriteria: {
        requiredSemanticElements: ['Credit Card', 'Payment Methods'],
      },
    };

    operator.setIntermediateMilestone(milestone);

    // Attempt to click behind the modal
    const out = await operator.execute(clickAt(150, 75, 'click proceed'));

    expect(out.intermediateState).toBeDefined();
    expect(out.intermediateState?.status).toBe(IntermediateProgressStatus.BLOCKED);
    expect(out.intermediateState?.evidence.activeDialogs?.length).toBeGreaterThan(0);
    expect(out.intermediateState?.evidence.accessibilityState?.hasModalOrDialog).toBe(true);
    expect(out.intermediateState?.feedback).toContain('BLOCKED');
    expect(out.intermediateState?.feedback).toContain('obstructing progress');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 5: Legitimate repeated actions (multi-action progress)
  // ══════════════════════════════════════════════════════════════════════════
  it('tracks legitimate repeated actions progressing towards a milestone without false stall', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <div id="scrollable" style="position:fixed;left:0;top:0;width:600px;height:500px;overflow-y:scroll;border:1px solid #ccc;">
        <div id="content" style="height:2500px;padding:20px;">
          <h2>Product Catalog</h2>
          <div id="items">
            <div class="item" role="listitem">Item 1</div>
            <div class="item" role="listitem">Item 2</div>
            <div class="item" role="listitem">Item 3</div>
          </div>
        </div>
      </div>
      <script>
        let loadCount = 0;
        const addItems = () => {
          loadCount++;
          const container = document.getElementById('items');
          for (let i = 0; i < 3; i++) {
            const div = document.createElement('div');
            div.className = 'item';
            div.setAttribute('role', 'listitem');
            div.innerText = 'Item dynamic ' + (loadCount * 3 + i);
            container.appendChild(div);
          }
        };
        const el = document.getElementById('scrollable');
        el.addEventListener('wheel', addItems);
      </script>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-load-ten-items',
      expectedMilestone: 'At least 10 products loaded',
      evaluationCriteria: {
        minimumItemCount: 10,
      },
    };

    operator.setIntermediateMilestone(milestone);

    // Action 1: Scroll down -> adds 3 items (total 6, milestone target 10 not yet met)
    const out1 = await operator.execute(scrollDown('scroll first time'));
    expect(out1.intermediateState?.status).toBe(IntermediateProgressStatus.IN_PROGRESS);
    expect(out1.intermediateState?.evidence.isStalled).toBe(false);

    // Action 2: Scroll down -> adds 3 items (total 9, still progressing)
    const out2 = await operator.execute(scrollDown('scroll second time'));
    expect(out2.intermediateState?.status).toBe(IntermediateProgressStatus.IN_PROGRESS);
    expect(out2.intermediateState?.evidence.isStalled).toBe(false);
    expect(out2.intermediateState?.evidence.actionsEvaluatedCount).toBe(2);

    // Action 3: Scroll down -> adds 3 items (total 12, satisfies minimumItemCount: 10!)
    const out3 = await operator.execute(scrollDown('scroll third time'));
    expect(out3.intermediateState?.status).toBe(IntermediateProgressStatus.REACHED);
    expect(out3.intermediateState?.evidence.isStalled).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 6: Recovery after failed attempts
  // ══════════════════════════════════════════════════════════════════════════
  it('detects recovery after failed attempts and resets no-progress counter', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <button id="disabled-login" disabled style="position:fixed;left:50px;top:50px;width:200px;height:50px;">Login (Disabled)</button>
      <button id="enable-btn" style="position:fixed;left:50px;top:120px;width:200px;height:50px;">Enable Login</button>
      <div id="dashboard" style="display:none;position:fixed;left:50px;top:200px;">
        <h2>User Dashboard</h2>
        <p>Welcome back, user!</p>
      </div>
      <script>
        const btn = document.getElementById('disabled-login');
        document.getElementById('enable-btn').addEventListener('click', () => {
          btn.disabled = false;
          btn.innerText = 'Login (Ready)';
        });
        btn.addEventListener('click', () => {
          if (!btn.disabled) {
            location.hash = '#/dashboard';
            document.getElementById('dashboard').style.display = 'block';
          }
        });
      </script>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-dashboard',
      expectedMilestone: 'User dashboard accessed',
      evaluationCriteria: {
        urlPattern: '#/dashboard',
        requiredSemanticElements: ['User Dashboard', 'Welcome back'],
      },
    };

    operator.setIntermediateMilestone(milestone);

    // Step 1: Click the disabled button (will result in NO_OP / ineffective attempt)
    const out1 = await operator.execute(clickAt(150, 75, 'click disabled button'));
    expect(out1.intermediateState?.status).toBe(IntermediateProgressStatus.IN_PROGRESS);
    expect(out1.intermediateState?.evidence.consecutiveNoProgressCount).toBe(1);

    // Step 2: Autonomous recovery action — Click "Enable Login" at (150, 145)
    await operator.execute(clickAt(150, 145, 'click enable button'));

    // Step 3: Now click login which is enabled
    const out3 = await operator.execute(clickAt(150, 75, 'click now-enabled login'));

    expect(out3.intermediateState?.status).toBe(IntermediateProgressStatus.REACHED);
    expect(out3.intermediateState?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(out3.intermediateState?.evidence.consecutiveNoProgressCount).toBe(0);
    expect(out3.intermediateState?.evidence.isStalled).toBe(false);
    expect(operator.getTaskStateTracker().getCompletedMilestones()).toContain(
      'milestone-dashboard',
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 7: Opaque element fallback (Canvas / Cross-origin iframe)
  // ══════════════════════════════════════════════════════════════════════════
  it('returns UNCERTAIN for opaque canvas elements where DOM cannot prove state', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:20px;">
      <h1>Drawing Application</h1>
      <canvas id="game-canvas" width="600" height="400" style="border:1px solid #000;display:block;"></canvas>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-canvas-rendered',
      expectedMilestone: 'Game stage completed on canvas',
      evaluationCriteria: {
        requiredSemanticElements: ['Level 2 Complete'],
      },
    };

    operator.setIntermediateMilestone(milestone);

    // Click inside the canvas
    const out = await operator.execute(clickAt(200, 200, 'click canvas surface'));

    expect(out.intermediateState).toBeDefined();
    // Host DOM has no text "Level 2 Complete", but contains opaque canvas
    expect(out.intermediateState?.status).toBe(IntermediateProgressStatus.UNCERTAIN);
    expect(out.intermediateState?.confidence).toBeLessThanOrEqual(0.5);
    expect(out.intermediateState?.feedback).toContain('UNCERTAIN');
    expect(out.intermediateState?.feedback).toContain('opaque');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 8: Stalled multi-action failure detection (>= 3 consecutive failures)
  // ══════════════════════════════════════════════════════════════════════════
  it('flags milestone as BLOCKED with stall recovery guidance after 3 consecutive ineffective actions', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;">
      <div style="position:fixed;left:50px;top:50px;width:200px;height:50px;background:#eee;">Dead zone</div>
    </body></html>`);

    const milestone: IntermediateStateContract = {
      stateId: 'milestone-dynamic-view',
      expectedMilestone: 'Dynamic settings panel active',
      evaluationCriteria: {
        urlPattern: '#/settings',
      },
    };

    operator.setIntermediateMilestone(milestone);

    // Action 1: Ineffective click in dead zone
    await operator.execute(clickAt(150, 75, 'click 1'));
    // Action 2: Ineffective click
    await operator.execute(clickAt(150, 75, 'click 2'));
    // Action 3: Ineffective click (3rd consecutive no-progress)
    const out3 = await operator.execute(clickAt(150, 75, 'click 3'));

    expect(out3.intermediateState?.status).toBe(IntermediateProgressStatus.BLOCKED);
    expect(out3.intermediateState?.evidence.isStalled).toBe(true);
    expect(out3.intermediateState?.evidence.consecutiveNoProgressCount).toBeGreaterThanOrEqual(3);
    expect(out3.intermediateState?.feedback).toContain('Stalled');
    expect(out3.intermediateState?.feedback).toContain('Consider alternative approach');
  });
});
