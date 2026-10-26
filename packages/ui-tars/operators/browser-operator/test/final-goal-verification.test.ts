/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LocalBrowser } from '@agent-infra/browser';
import type { Page } from '@agent-infra/browser';
import { BrowserOperator } from '../src/browser-operator';
import { GoalCategory, FinalGoalStatus } from '../src/verification';
import type { ExecuteParams, FinalGoalContract } from '../src/types';
import { StatusEnum } from '../src/types';

describe('Milestone 3: Evidence-Grounded Final-Goal Verification (Chromium)', () => {
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
      page,
    });
  }, 30000);

  afterAll(async () => {
    if (localBrowser) {
      await localBrowser.close();
    }
  });

  beforeEach(async () => {
    operator.getActionVerifier().reset();
    operator.getTaskStateTracker().clear();
    operator.getFinalGoalVerifier().clear();
    await page.goto('about:blank');
  });

  // ── Helper ───────────────────────────────────────────────────────────────
  function finishAction(thought: string): ExecuteParams {
    return {
      prediction: `Action: finished()`,
      parsedPrediction: {
        action_type: 'finished',
        action_inputs: {},
        reflection: null,
        thought,
      },
      screenWidth: 1280,
      screenHeight: 800,
      scaleFactor: 1,
      factors: [1, 1],
    };
  }

  // ── 1. Premature finished() Rejection ─────────────────────────────────────
  it('1. rejects premature finished() when form is incomplete and state change is unverified', async () => {
    await page.setContent(`
      <html>
        <body>
          <form id="profile-form">
            <input id="email" type="email" value="test@example.com" />
            <input id="phone" type="text" value="" />
            <button type="submit">Save Profile</button>
          </form>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Submit updated profile',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        successSemanticElements: ['Profile successfully updated', 'Saved'],
      },
    };
    operator.setFinalGoalContract(contract);

    const result = await operator.execute(
      finishAction('I clicked save profile so the task is complete.'),
    );

    expect(result.status).toBe(StatusEnum.RUNNING);
    expect(result.finalGoalVerification).toBeDefined();
    expect(result.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(result.finalGoalVerification?.feedback).toContain(
      'State change not yet confirmed',
    );
    expect(result.finalGoalVerification?.rejectionCount).toBe(1);
  });

  // ── 2. Correct Final-Goal Verification ────────────────────────────────────
  it('2. verifies completion when intended state change evidence is present', async () => {
    await page.setContent(`
      <html>
        <body>
          <div role="status" class="alert alert-success">Profile successfully updated</div>
          <h2>Account Details</h2>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Submit updated profile',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        successSemanticElements: ['Profile successfully updated'],
      },
    };
    operator.setFinalGoalContract(contract);

    const result = await operator.execute(
      finishAction(
        'Verified that profile updated confirmation banner is visible.',
      ),
    );

    expect(result.status).toBe(StatusEnum.END);
    expect(result.finalGoalVerification?.status).toBe(FinalGoalStatus.VERIFIED);
    expect(result.finalGoalVerification?.feedback).toContain(
      'State change confirmed',
    );
  });

  // ── 3. Incorrect Target Selection ─────────────────────────────────────────
  it('3. rejects completion when incorrect item or criteria is selected', async () => {
    await page.setContent(`
      <html>
        <body>
          <div id="cart">
            <span class="item-name">Keyboard Stand</span>
            <span class="item-qty">1</span>
          </div>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Add Ergonomic Mechanical Keyboard to cart',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        successSemanticElements: ['Ergonomic Mechanical Keyboard'],
      },
    };
    operator.setFinalGoalContract(contract);

    const result = await operator.execute(
      finishAction('Finished adding the item to the cart.'),
    );

    expect(result.status).toBe(StatusEnum.RUNNING);
    expect(result.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(result.finalGoalVerification?.feedback).toContain(
      'Ergonomic Mechanical Keyboard',
    );
  });

  // ── 4. Delayed Success & Loading / Buffering ──────────────────────────────
  it('4. detects pending loading states and verifies only after settlement', async () => {
    await page.setContent(`
      <html>
        <body>
          <div class="spinner" role="progressbar" aria-busy="true">Loading order...</div>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Place order and wait for confirmation',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        successSemanticElements: ['Order Confirmed #12345'],
      },
    };
    operator.setFinalGoalContract(contract);

    // First attempt: loading indicator is active -> UNFULFILLED
    const pendingResult = await operator.execute(
      finishAction('Finished placing order.'),
    );
    expect(pendingResult.status).toBe(StatusEnum.RUNNING);
    expect(pendingResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(pendingResult.finalGoalVerification?.feedback).toContain(
      'actively loading/processing',
    );

    // Simulate async settlement: remove spinner, show confirmation
    await page.setContent(`
      <html>
        <body>
          <div role="status">Order Confirmed #12345</div>
        </body>
      </html>
    `);

    const settledResult = await operator.execute(
      finishAction('Order confirmed banner is visible now.'),
    );
    expect(settledResult.status).toBe(StatusEnum.END);
    expect(settledResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.VERIFIED,
    );
  });

  // ── 5. Advertisements versus Requested Media Playback ─────────────────────
  it('5. distinguishes video advertisements from requested media playback', async () => {
    // Stage 1: Video is playing, but within an ad container (.ad-showing)
    await page.setContent(`
      <html>
        <body>
          <div class="ad-showing video-ads">
            <span class="ad-text">Ad 1 of 2: 15s remaining</span>
            <video id="player" autoplay src="data:video/mp4;base64,AAAA"></video>
          </div>
          <script>
            Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get: () => false, configurable: true });
            Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get: () => 5.2, configurable: true });
            Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
          </script>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Play the requested tutorial video',
      category: GoalCategory.CONFIRMATION,
      criteria: {
        requireMediaPlayback: true,
      },
    };
    operator.setFinalGoalContract(contract);

    const adResult = await operator.execute(
      finishAction('The video player is running so the tutorial is playing.'),
    );
    expect(adResult.status).toBe(StatusEnum.RUNNING);
    expect(adResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(adResult.finalGoalVerification?.feedback).toContain('advertisement');

    // Stage 2: Ad ends, main video plays without ad indicators
    await page.setContent(`
      <html>
        <body>
          <div class="main-video-player">
            <video id="player" autoplay src="data:video/mp4;base64,AAAA"></video>
            <h1>Advanced TypeScript Tutorial</h1>
          </div>
          <script>
            Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get: () => false, configurable: true });
            Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get: () => 12.4, configurable: true });
            Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
          </script>
        </body>
      </html>
    `);

    const playbackResult = await operator.execute(
      finishAction('The tutorial content is now actively playing.'),
    );
    expect(playbackResult.status).toBe(StatusEnum.END);
    expect(playbackResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.VERIFIED,
    );
  });

  // ── 6. Extraction with Missing Requested Information ──────────────────────
  it('6. rejects extraction when required information is absent from the thought response', async () => {
    await page.setContent(`
      <html>
        <body>
          <div id="patient-data">
            <span class="id">ID: 9942</span>
            <span class="diagnosis">Diagnosis: Acute Bronchitis</span>
          </div>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Extract patient diagnosis and prescription',
      category: GoalCategory.EXTRACTION,
      criteria: {
        requiredExtractedFields: ['diagnosis', 'prescription'],
      },
    };
    operator.setFinalGoalContract(contract);

    // Thought only includes diagnosis, prescription is omitted
    const missingResult = await operator.execute(
      finishAction('Extracted diagnosis: Acute Bronchitis.'),
    );
    expect(missingResult.status).toBe(StatusEnum.RUNNING);
    expect(missingResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(missingResult.finalGoalVerification?.feedback).toContain(
      'prescription',
    );

    // Complete extraction
    const completeResult = await operator.execute(
      finishAction(
        'Extracted diagnosis: Acute Bronchitis. prescription: Amoxicillin 500mg PO TID.',
      ),
    );
    expect(completeResult.status).toBe(StatusEnum.END);
    expect(completeResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.VERIFIED,
    );
  });

  // ── 7. Successful and Failed State Changes ────────────────────────────────
  it('7. blocks completion when UI displays explicit failure alerts or error semantics', async () => {
    await page.setContent(`
      <html>
        <body>
          <form id="checkout">
            <div role="alert" class="alert-danger">Transaction declined: insufficient funds</div>
            <button type="submit">Submit Payment</button>
          </form>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Complete checkout payment',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        successSemanticElements: ['Receipt #', 'Thank you for your order'],
        failureSemanticElements: ['Transaction declined', 'Payment failed'],
      },
    };
    operator.setFinalGoalContract(contract);

    const errorResult = await operator.execute(
      finishAction('Submitted checkout form, payment submitted.'),
    );

    expect(errorResult.status).toBe(StatusEnum.RUNNING);
    expect(errorResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.BLOCKED,
    );
    expect(errorResult.finalGoalVerification?.feedback).toContain(
      'Transaction declined',
    );
  });

  // ── 8. Opaque Canvas / Iframe Uncertainty ─────────────────────────────────
  it('8. preserves uncertainty for visually opaque interfaces without DOM semantics', async () => {
    await page.setContent(`
      <html>
        <body>
          <canvas id="medical-viewer" width="600" height="400"></canvas>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Confirm MRI scan slice loaded',
      category: GoalCategory.CONFIRMATION,
    };
    operator.setFinalGoalContract(contract);

    // Non-substantive thought on opaque canvas
    const uncertainResult = await operator.execute(finishAction('Done.'));

    expect(uncertainResult.status).toBe(StatusEnum.RUNNING);
    expect(uncertainResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNCERTAIN,
    );
    expect(uncertainResult.finalGoalVerification?.feedback).toContain(
      'visually opaque element',
    );
  });

  // ── 9. Repeated Failed Completion Attempts & User-Assistance Escalation ───
  it('9. bounds completion rejections and escalates to user assistance after 3 attempts', async () => {
    await page.setContent(`
      <html>
        <body>
          <div>Static unfulfilled page</div>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Locate tracking code',
      category: GoalCategory.EXTRACTION,
      criteria: {
        requiredExtractedFields: ['tracking_code'],
      },
      maxRejections: 3,
    };
    operator.setFinalGoalContract(contract);

    // Attempt 1: Rejected
    const r1 = await operator.execute(finishAction('Attempt 1 finished'));
    expect(r1.finalGoalVerification?.rejectionCount).toBe(1);
    expect(r1.finalGoalVerification?.terminalEscalation).toBeFalsy();

    // Attempt 2: Rejected
    const r2 = await operator.execute(finishAction('Attempt 2 finished'));
    expect(r2.finalGoalVerification?.rejectionCount).toBe(2);
    expect(r2.finalGoalVerification?.terminalEscalation).toBeFalsy();

    // Attempt 3: Terminal escalation triggered
    const r3 = await operator.execute(finishAction('Attempt 3 finished'));
    expect(r3.finalGoalVerification?.rejectionCount).toBe(3);
    expect(r3.finalGoalVerification?.status).toBe(FinalGoalStatus.BLOCKED);
    expect(r3.finalGoalVerification?.terminalEscalation).toBe(true);
    expect(r3.finalGoalVerification?.feedback).toContain(
      'Maximum verification attempts (3) exceeded',
    );
  });

  // ── 10. Sensitive and Irreversible Operations Protection ──────────────────
  it('10. blocks unauthorized sensitive or irreversible state changes', async () => {
    await page.setContent(`
      <html>
        <body>
          <div role="status">Transfer completed: $50,000 sent</div>
        </body>
      </html>
    `);

    const contract: FinalGoalContract = {
      goalDescription: 'Execute international wire transfer',
      category: GoalCategory.STATE_CHANGE,
      criteria: {
        requiresExplicitApproval: true,
        isPreAuthorized: false,
        successSemanticElements: ['Transfer completed'],
      },
    };
    operator.setFinalGoalContract(contract);

    const sensitiveResult = await operator.execute(
      finishAction('Transfer has been executed.'),
    );

    expect(sensitiveResult.status).toBe(StatusEnum.RUNNING);
    expect(sensitiveResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.BLOCKED,
    );
    expect(sensitiveResult.finalGoalVerification?.feedback).toContain(
      'requires explicit user authorization',
    );
  });

  // ── 11. Concurrent Sessions with Independent Goal Verification ────────────
  it('11. maintains strictly isolated goal verification across concurrent browser operators', async () => {
    const session1 = await localBrowser.createSession({
      defaultViewport: { width: 1280, height: 800 },
    });
    const session2 = await localBrowser.createSession({
      defaultViewport: { width: 1280, height: 800 },
    });

    const op1 = new BrowserOperator({
      browser: session1,
      browserType: 'chrome',
    });
    const op2 = new BrowserOperator({
      browser: session2,
      browserType: 'chrome',
    });

    try {
      const p1 = await session1.getActivePage();
      const p2 = await session2.getActivePage();
      await p1.setContent('<div>Session 1: Task A completed</div>');
      await p2.setContent('<div>Session 2: In progress</div>');

      const contract1: FinalGoalContract = {
        goalDescription: 'Complete Task A',
        category: GoalCategory.STATE_CHANGE,
        criteria: { successSemanticElements: ['Task A completed'] },
      };
      const contract2: FinalGoalContract = {
        goalDescription: 'Complete Task B',
        category: GoalCategory.STATE_CHANGE,
        criteria: { successSemanticElements: ['Task B completed'] },
      };

      op1.setFinalGoalContract(contract1);
      op2.setFinalGoalContract(contract2);

      const res1 = await op1.execute(finishAction('Finished session 1'));
      const res2 = await op2.execute(finishAction('Finished session 2'));

      expect(res1.status).toBe(StatusEnum.END);
      expect(res1.finalGoalVerification?.status).toBe(FinalGoalStatus.VERIFIED);

      expect(res2.status).toBe(StatusEnum.RUNNING);
      expect(res2.finalGoalVerification?.status).toBe(
        FinalGoalStatus.UNFULFILLED,
      );
      expect(op1.getFinalGoalVerifier().getRejectionCount()).toBe(0);
      expect(op2.getFinalGoalVerifier().getRejectionCount()).toBe(1);
    } finally {
      await session1.close();
      await session2.close();
    }
  });

  // ── 12. Inference of Missing or Ambiguous Contracts ───────────────────────
  it('12. explicitly rejects finished() when no contract is provided and thought is empty', async () => {
    await page.setContent('<div>Plain page</div>');
    // No contract set

    const emptyResult = await operator.execute(finishAction(''));

    expect(emptyResult.status).toBe(StatusEnum.RUNNING);
    expect(emptyResult.finalGoalVerification?.status).toBe(
      FinalGoalStatus.UNFULFILLED,
    );
    expect(emptyResult.finalGoalVerification?.feedback).toContain(
      'Finished called without observable evidence or substantive report',
    );
  });
});
