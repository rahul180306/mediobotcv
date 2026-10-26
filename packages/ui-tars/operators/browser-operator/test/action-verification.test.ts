/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LocalBrowser } from '@agent-infra/browser';
import type { Page } from '@agent-infra/browser';
import { BrowserOperator } from '../src/browser-operator';
import { ActionOutcomeCategory } from '../src/verification';
import type { ExecuteParams } from '../src/types';



describe('Milestone 1C Hardened: Action-Level Outcome Verification', () => {
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
    if (localBrowser) await localBrowser.close();
  });

  beforeEach(async () => {
    // Reset repetition tracker between tests to prevent cross-test state contamination
    operator.getActionVerifier().reset();
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

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 1 — Core classification regressions
  // ══════════════════════════════════════════════════════════════════════════

  it('classifies DOM-mutating click as SUCCESS', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="btn" style="width:200px;height:50px;">Count: 0</button>
      <script>
        let n = 0;
        document.getElementById('btn').addEventListener('click', (e) => {
          n++; e.target.innerText = 'Count: ' + n;
          e.target.setAttribute('data-count', n);
        });
      <\/script></body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'click counter'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
    expect(out.verification?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(out.verification?.evidence.domMutationCount).toBeGreaterThan(0);
  });

  it('classifies inert-element click as NO_OP', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <div id="static" style="width:200px;height:50px;background:#eee;">Static</div>
    </body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'click inert'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.NO_OP);
    expect(out.verification?.confidence).toBeLessThanOrEqual(0.95);
    expect(out.verification?.evidence.domMutationCount).toBe(0);
    expect(out.verification?.evidence.focusChanged).toBe(false);
  });

  it('classifies overlay-blocked click as BLOCKED', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button style="width:200px;height:50px;">Target</button>
      <div class="modal-backdrop overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,0.5);"></div>
    </body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'click blocked by overlay'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.BLOCKED);
    expect(out.verification?.evidence.isBlockedByOverlay).toBe(true);
    expect(out.verification?.feedback).toContain('intercepted by an overlay');
  });

  it('classifies disabled-element click as BLOCKED', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="d" disabled style="width:200px;height:50px;">Disabled</button>
    </body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'click disabled'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.BLOCKED);
    expect(out.verification?.feedback).toContain('disabled');
  });

  it('classifies async-spinner click as PENDING', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="async-btn" style="width:200px;height:50px;">Submit</button>
      <div id="lc"></div>
      <script>
        document.getElementById('async-btn').addEventListener('click', (e) => {
          e.target.setAttribute('aria-busy', 'true');
          const s = document.createElement('div');
          s.className = 'spinner'; s.setAttribute('role', 'progressbar'); s.innerText = 'Loading…';
          document.getElementById('lc').appendChild(s);
        });
      <\/script></body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'click async'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.PENDING);
    expect(out.verification?.evidence.isPendingDetected).toBe(true);
  });

  it('classifies type-into-input as SUCCESS with inputValueChanged evidence', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <input id="inp" type="text" style="width:250px;height:40px;" />
    </body></html>`);

    await operator.execute(clickAt(175, 70, 'focus input'));
    const out = await operator.execute({
      prediction: "Action: type(content='MedioBot AI')",
      parsedPrediction: {
        action_type: 'type',
        action_inputs: { content: 'MedioBot AI' },
        reflection: null,
        thought: 'type query',
      },
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
    expect(out.verification?.confidence).toBe(1.0);
    expect(out.verification?.evidence.inputValueChanged).toBe(true);
  });

  it('classifies page navigation as SUCCESS with URL change evidence', async () => {
    const url = 'data:text/html,<html><body><h1>Nav</h1></body></html>';
    const out = await operator.execute({
      prediction: `Action: navigate(content='${url}')`,
      parsedPrediction: {
        action_type: 'navigate',
        action_inputs: { content: url },
        reflection: null,
        thought: 'navigate',
      },
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
    expect(out.verification?.confidence).toBe(1.0);
    expect(out.verification?.evidence.navigationOccurred).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 2 — Hardening: false certainty elimination
  // ══════════════════════════════════════════════════════════════════════════

  it('[HARDEN] canvas click yields UNCERTAIN — DOM metadata unavailable for opaque elements', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;">
      <canvas id="c" width="400" height="300" style="background:#333;display:block;"></canvas>
      <script>
        const ctx = document.getElementById('c').getContext('2d');
        ctx.fillStyle = 'blue'; ctx.fillRect(0,0,400,300);
        document.getElementById('c').addEventListener('click', () => {
          ctx.fillStyle = 'red'; ctx.fillRect(0,0,400,300);
        });
      <\/script></body></html>`);

    const out = await operator.execute(clickAt(200, 150, 'click canvas'));
    // Canvas interactions cannot be verified via DOM — must be UNCERTAIN, not NO_OP
    expect(out.verification?.category).toBe(ActionOutcomeCategory.UNCERTAIN);
    expect(out.verification?.feedback).toContain('visually opaque');
  });

  it('[HARDEN] iframe click yields UNCERTAIN — cross-document DOM inaccessible', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;">
      <iframe id="fr" src="about:blank" style="width:400px;height:300px;border:none;"></iframe>
    </body></html>`);

    const out = await operator.execute(clickAt(200, 150, 'click iframe'));
    expect(out.verification?.category).toBe(ActionOutcomeCategory.UNCERTAIN);
    expect(out.verification?.feedback).toContain('visually opaque');
  });

  it('[HARDEN] background-only DOM mutations do not produce false SUCCESS on inert click', async () => {
    await page.setContent(`<!DOCTYPE html><html>
      <head><title>Test</title></head>
      <body style="margin:0;padding:50px;">
        <div id="target" style="width:200px;height:50px;background:#ddd;">Static target</div>
        <script>
          // Background polling that mutates only the document title (head element)
          let i = 0;
          setInterval(() => { document.title = 'Poll ' + (++i); }, 80);
        <\/script>
      </body></html>`);

    // Wait for background polling to fire at least once
    await new Promise((r) => setTimeout(r, 250));

    const out = await operator.execute(clickAt(150, 75, 'click with background timer'));
    // Background timer mutates <title> (head tag) — this must NOT produce false SUCCESS.
    // Correct result: NO_OP (no non-background mutations) or UNCERTAIN (indeterminate).
    expect(out.verification?.category).not.toBe(ActionOutcomeCategory.SUCCESS);
    expect([ActionOutcomeCategory.NO_OP, ActionOutcomeCategory.UNCERTAIN]).toContain(
      out.verification?.category,
    );
  });

  it('[HARDEN] virtual scroll (DOM mutates, no window.scrollY change) classified as SUCCESS', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;">
      <div id="list" style="height:300px;overflow-y:auto;border:1px solid #ccc;">
        ${Array.from({ length: 100 }, (_, i) => `<div style="height:30px;padding:4px;">Item ${i}</div>`).join('')}
      </div>
      <script>
        document.getElementById('list').addEventListener('scroll', () => {
          const extra = document.createElement('div');
          extra.style.height = '30px';
          extra.innerText = 'Virtual item ' + Math.random();
          document.getElementById('list').appendChild(extra);
        });
      <\/script></body></html>`);

    const out = await operator.execute({
      prediction: "Action: scroll(coordinate=[640,150], direction='down', amount=3)",
      parsedPrediction: {
        action_type: 'scroll',
        action_inputs: { coordinate: [640, 150], direction: 'down', amount: 3 },
        reflection: null,
        thought: 'scroll virtual list',
      },
      screenWidth: 1280,
      screenHeight: 800,
    });
    // Virtual scroll: DOM mutated → SUCCESS (not NO_OP)
    expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
    expect(out.verification?.feedback).toContain('virtual');
  });

  it('[HARDEN] SPA navigation via history.pushState detected as SUCCESS', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="nav-btn" style="width:200px;height:50px;">Go to /page2</button>
      <script>
        document.getElementById('nav-btn').addEventListener('click', () => {
          history.pushState({}, 'Page 2', '#/spa-page2');
        });
      <\/script></body></html>`);

    const out = await operator.execute(clickAt(150, 75, 'SPA navigate'));
    expect(out.verification?.evidence.navigationOccurred).toBe(true);
    expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 3 — Retry-loop safety
  // ══════════════════════════════════════════════════════════════════════════

  it('[HARDEN] distinguishes legitimate repeated clicks from ineffective repetitive loops', async () => {
    operator.getActionVerifier().reset();

    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="step" style="width:100px;height:40px;">Step: 0</button>
      <div id="inert" style="width:100px;height:40px;margin-top:20px;background:#eee;">Inert</div>
      <script>
        let s = 0;
        document.getElementById('step').addEventListener('click', (e) => {
          s++; e.target.innerText = 'Step: ' + s;
        });
      <\/script></body></html>`);

    // Part A: legitimate repetition — each click changes DOM
    for (let i = 1; i <= 3; i++) {
      const out = await operator.execute(clickAt(100, 70, `step ${i}`));
      expect(out.verification?.category).toBe(ActionOutcomeCategory.SUCCESS);
      if (i > 1) {
        expect(out.verification?.isLegitimateRepetition).toBe(true);
        expect(out.verification?.feedback).toContain('LEGITIMATE REPETITION');
      }
    }

    // Part B: ineffective loop — inert element emits RECOVERY HINT after 2+ consecutive NO_OP
    for (let j = 1; j <= 3; j++) {
      const out = await operator.execute(clickAt(100, 130, `inert ${j}`));
      expect(out.verification?.category).toBe(ActionOutcomeCategory.NO_OP);
      if (j >= 2) {
        expect(out.verification?.consecutiveNoOpCount).toBeGreaterThanOrEqual(2);
        expect(out.verification?.feedback).toContain('RECOVERY HINT');
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 4 — Prompt alignment: IMAGE_PLACEHOLDER integrity
  // NOTE: toVlmModelFormat tests live in @ui-tars/sdk/src/utils.test.ts
  // (the function is not exported from @ui-tars/sdk package entry point).
  // See: packages/ui-tars/sdk/src/utils.test.ts — GROUP: actionOutcomeFeedback alignment
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 5 — Latency benchmark: p50, p95, p99, worst-case
  // ══════════════════════════════════════════════════════════════════════════

  it('[BENCHMARK] verification overhead: p50 < 10ms, p95 < 25ms, p99 < 40ms, worst < 60ms', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:20px;">
      <button id="perf-btn" style="width:100px;height:40px;">Perf</button>
      <script>
        document.getElementById('perf-btn').addEventListener('click', (e) => {
          e.target.innerText = 'C ' + Math.random();
          e.target.setAttribute('data-ts', Date.now());
        });
      <\/script></body></html>`);

    const verifier = operator.getActionVerifier();
    const ITERATIONS = 50;
    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const coords = { x: 50, y: 30 };
      const t0 = performance.now();
      const pre = await verifier.capturePreSnapshot(page, 'click', {}, coords);
      await page.evaluate(() => (document.getElementById('perf-btn') as any)?.click());
      const post = await verifier.capturePostSnapshot(page, pre, 'click', {}, coords);
      verifier.evaluateOutcome(pre, post, 'click', {}, coords);
      durations.push(performance.now() - t0);
    }

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(ITERATIONS * 0.50)];
    const p95 = durations[Math.floor(ITERATIONS * 0.95)];
    const p99 = durations[Math.floor(ITERATIONS * 0.99)];
    const worst = durations[ITERATIONS - 1];

    console.log(
      `[Verification Latency] p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, ` +
      `p99=${p99.toFixed(2)}ms, worst=${worst.toFixed(2)}ms`,
    );

    expect(p50).toBeLessThan(10);
    expect(p95).toBeLessThan(25);
    expect(p99).toBeLessThan(40);
    expect(worst).toBeLessThan(60);
  }, 60000);

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 6 — Memory hygiene
  // ══════════════════════════════════════════════════════════════════════════

  it('[HARDEN] detached page capturePreSnapshot returns safe fallback without throwing', async () => {
    const verifier = operator.getActionVerifier();
    const fakePage = {
      evaluate: async () => { throw new Error('Page detached'); },
      viewport: () => null,
    } as any;

    const pre = await verifier.capturePreSnapshot(fakePage, 'click', {});
    expect(pre).toBeDefined();
    expect(pre.url).toBe('');
    expect(pre.activeElement.tag).toBe('body');
  });

  it('[HARDEN] consecutive action executions do not accumulate stale mutation counts', async () => {
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:50px;">
      <button id="mut-btn" style="width:200px;height:50px;">Mutate</button>
      <script>
        document.getElementById('mut-btn').addEventListener('click', (e) => {
          e.target.setAttribute('data-n', Math.random());
        });
      <\/script></body></html>`);

    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await operator.execute(clickAt(150, 75, `click ${i}`));
      counts.push(out.verification?.evidence.domMutationCount ?? 0);
    }

    // Each action must report its own fresh mutation count
    counts.forEach((count) => {
      expect(count).toBeGreaterThan(0);       // button always mutates
      expect(count).toBeLessThan(50);         // must not accumulate prior counts
    });
  });
});

