/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page } from '@agent-infra/browser';
import {
  ActionOutcomeCategory,
  ActionVerificationResult,
  PreActionSnapshot,
  PostActionSnapshot,
  IntermediateProgressStatus,
  IntermediateStateContract,
  IntermediateStateEvidence,
  IntermediateStateVerificationResult,
  IntermediateEvaluationContext,
} from './types';

/**
 * TaskStateTracker (Milestone 2)
 *
 * Implements lightweight, intent-aware intermediate-state verification across
 * multi-action computer-use workflows.
 *
 * Key Capabilities:
 *  1. Tracks milestone lifecycle: NOT_STARTED, IN_PROGRESS, REACHED, BLOCKED, UNCERTAIN.
 *  2. Evaluates universal browser evidence (URL transitions, ARIA/accessibility states,
 *     semantic landmarks, item counts, error banners) without website-specific selectors.
 *  3. Detects deviations (e.g. wrong navigation, 404/error pages, modal obstacles).
 *  4. Detects stalled milestones (3+ consecutive no-progress actions) and emits recovery hints.
 *  5. Supports async transitions, loading states, and SPAs without premature failure.
 *  6. Completely preserves UI-TARS autonomous decision-making without scripted execution.
 */
export class TaskStateTracker {
  private activeMilestone: IntermediateStateContract | null = null;
  private milestoneQueue: IntermediateStateContract[] = [];
  private completedMilestones: string[] = [];
  private actionsEvaluatedCount = 0;
  private consecutiveNoProgressCount = 0;
  private history: IntermediateStateVerificationResult[] = [];
  private readonly maxHistoryLength = 25;

  /**
   * Sets a single active intermediate milestone to track.
   */
  public setMilestone(milestone: IntermediateStateContract): void {
    this.activeMilestone = milestone;
    this.milestoneQueue = [];
    this.actionsEvaluatedCount = 0;
    this.consecutiveNoProgressCount = 0;
  }

  /**
   * Sets a sequence of intermediate milestones. The first milestone is set active.
   */
  public setMilestones(milestones: IntermediateStateContract[]): void {
    if (milestones.length === 0) {
      this.clear();
      return;
    }
    const [first, ...rest] = milestones;
    this.activeMilestone = first;
    this.milestoneQueue = rest;
    this.actionsEvaluatedCount = 0;
    this.consecutiveNoProgressCount = 0;
  }

  /**
   * Returns the currently tracked intermediate milestone, if any.
   */
  public getActiveMilestone(): IntermediateStateContract | null {
    return this.activeMilestone;
  }

  /**
   * Returns all completed milestone IDs.
   */
  public getCompletedMilestones(): string[] {
    return [...this.completedMilestones];
  }

  /**
   * Clears all milestones and resets tracking.
   */
  public clear(): void {
    this.activeMilestone = null;
    this.milestoneQueue = [];
    this.actionsEvaluatedCount = 0;
    this.consecutiveNoProgressCount = 0;
    this.history = [];
  }

  /**
   * Resets progress counters while keeping the active milestone.
   */
  public reset(): void {
    this.actionsEvaluatedCount = 0;
    this.consecutiveNoProgressCount = 0;
    this.history = [];
  }

  /**
   * Evaluates the current page and action outcome against the active intermediate milestone.
   * Runs in < 15ms overhead via a single lightweight evaluation pass.
   */
  public async evaluate(
    page: Page,
    preSnapshot?: PreActionSnapshot | null,
    postSnapshot?: PostActionSnapshot | null,
    actionVerification?: ActionVerificationResult,
    actionType = '',
    actionInputs: Record<string, any> = {},
  ): Promise<IntermediateStateVerificationResult | undefined> {
    if (!this.activeMilestone) {
      return undefined;
    }

    const t0 = performance.now();
    this.actionsEvaluatedCount++;

    // Fast-path evaluation context
    const currentUrl =
      postSnapshot?.url || (typeof page.url === 'function' ? page.url() : '');
    const previousUrl = preSnapshot?.url || '';

    // Sample universal browser telemetry in a single lightweight evaluate pass
    let telemetry: {
      headings: string[];
      landmarks: string[];
      activeDialogs: string[];
      errorElements: string[];
      isBusy: boolean;
      itemCount: number;
      bodyTextSnippet: string;
      hasOpaqueSurface: boolean;
    };

    try {
      telemetry = await page.evaluate(() => {
        // Universal headings (h1-h3 or role="heading")
        const headings = Array.from(
          document.querySelectorAll('h1, h2, h3, [role="heading"]'),
        )
          .map((el) => (el.textContent || '').trim().slice(0, 100))
          .filter((t) => t.length > 0);

        // Universal landmarks
        const landmarks = Array.from(
          document.querySelectorAll(
            'main, [role="main"], [role="search"], [role="navigation"], [role="dialog"], [role="alert"]',
          ),
        ).map(
          (el) =>
            el.tagName.toLowerCase() +
            (el.getAttribute('role') ? `[role="${el.getAttribute('role')}"]` : ''),
        );

        // Modals / Overlays / Blocking backdrops
        const activeDialogs = Array.from(
          document.querySelectorAll(
            'dialog[open], [role="dialog"][aria-modal="true"], .modal.show, .modal-backdrop, .overlay.active',
          ),
        ).map(
          (el) =>
            el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : '') +
            (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        );

        // Error banners or alerts
        const errorElements = Array.from(
          document.querySelectorAll(
            '[role="alert"], .error-banner, .alert-danger, .error-message, .error-text',
          ),
        )
          .map((el) => (el.textContent || '').trim().slice(0, 100))
          .filter((t) => t.length > 0);

        // Loading indicators
        const isAriaBusy =
          document.body?.getAttribute('aria-busy') === 'true' ||
          !!document.querySelector('[aria-busy="true"]');
        const hasSpinner = !!document.querySelector(
          '.spinner, .loading, .busy, [role="progressbar"]',
        );

        // Semantic items count
        const itemCount = document.querySelectorAll(
          '[role="listitem"], article, table tbody tr, .card, .item, .result-item',
        ).length;

        // Compact body text snippet for universal text verification
        const bodyTextSnippet = (document.body?.innerText || '').slice(0, 5000);

        // Opaque visual surfaces (canvas, cross-origin iframe, video)
        const hasOpaqueSurface = !!document.querySelector('canvas, iframe, video');

        return {
          headings,
          landmarks,
          activeDialogs,
          errorElements,
          isBusy: isAriaBusy || hasSpinner,
          itemCount,
          bodyTextSnippet,
          hasOpaqueSurface,
        };
      });
    } catch {
      // Fallback for detached or early lifecycle pages
      telemetry = {
        headings: [],
        landmarks: [],
        activeDialogs: [],
        errorElements: [],
        isBusy: false,
        itemCount: 0,
        bodyTextSnippet: '',
        hasOpaqueSurface: false,
      };
    }

    const milestone = this.activeMilestone;
    const criteria = milestone.evaluationCriteria || {};

    let status = IntermediateProgressStatus.IN_PROGRESS;
    let confidence = 0.5;
    let feedback = '';
    let deviationDetected = false;
    let deviationReason: string | undefined = undefined;
    const semanticMatches: string[] = [];
    const semanticViolations: string[] = [];

    // ── Check Custom Evaluator if provided ─────────────────────────────────
    if (typeof criteria.customEvaluator === 'function' || typeof milestone.evaluate === 'function') {
      const evalFn = criteria.customEvaluator || milestone.evaluate!;
      try {
        const customRes = await evalFn({
          url: currentUrl,
          previousUrl,
          actionType,
          actionInputs,
          actionVerification,
          elapsedActions: this.actionsEvaluatedCount,
          consecutiveNoProgressCount: this.consecutiveNoProgressCount,
          semanticHeadings: telemetry.headings,
          semanticLandmarks: telemetry.landmarks,
          activeDialogs: telemetry.activeDialogs,
          errorBanners: telemetry.errorElements,
          itemCount: telemetry.itemCount,
          isPending: !!postSnapshot?.isPending || telemetry.isBusy,
          isOpaqueSurface: telemetry.hasOpaqueSurface,
        });

        if (customRes.reached) {
          status = IntermediateProgressStatus.REACHED;
          confidence = customRes.confidence ?? 0.95;
          feedback = `[Intermediate Progress: REACHED - Milestone '${milestone.expectedMilestone}' confirmed.]`;
          this.consecutiveNoProgressCount = 0;
          this.advanceMilestone(milestone.stateId);
          return this.recordResult(milestone, status, confidence, feedback, {
            currentUrl,
            semanticMatches: ['custom-evaluator'],
            actionsEvaluatedCount: this.actionsEvaluatedCount,
            consecutiveNoProgressCount: 0,
            isStalled: false,
          }, performance.now() - t0);
        } else if (customRes.deviationReason) {
          status = IntermediateProgressStatus.BLOCKED;
          confidence = 0.9;
          deviationDetected = true;
          deviationReason = customRes.deviationReason;
          this.consecutiveNoProgressCount++;
          feedback = `[Intermediate Progress: BLOCKED - Milestone '${milestone.expectedMilestone}' deviated: ${deviationReason}. Recovery required.]`;
          return this.recordResult(milestone, status, confidence, feedback, {
            currentUrl,
            semanticMatches: [],
            actionsEvaluatedCount: this.actionsEvaluatedCount,
            consecutiveNoProgressCount: this.consecutiveNoProgressCount,
            isStalled: this.consecutiveNoProgressCount >= 3,
            deviationDetected: true,
            deviationReason,
          }, performance.now() - t0);
        }
      } catch {
        // Fall through to standard evaluation
      }
    }

    // ── 1. Deviation & Forbidden URL Check ──────────────────────────────────
    if (criteria.forbiddenUrlPatterns && criteria.forbiddenUrlPatterns.length > 0) {
      for (const pattern of criteria.forbiddenUrlPatterns) {
        const matches =
          typeof pattern === 'string'
            ? currentUrl.toLowerCase().includes(pattern.toLowerCase())
            : pattern.test(currentUrl);
        if (matches) {
          deviationDetected = true;
          deviationReason = `Navigated to forbidden/error URL '${currentUrl}' (matched ${pattern})`;
          break;
        }
      }
    }

    // Generic error URLs check
    if (
      !deviationDetected &&
      (/\/(404|500|error|access-denied|blocked|captcha)(\/|\?|$)/i.test(currentUrl) ||
        currentUrl.includes('error-page'))
    ) {
      deviationDetected = true;
      deviationReason = `Navigated to error/barrier URL '${currentUrl}'`;
    }

    // ── 2. Blocking Overlays / Dialogs Check ────────────────────────────────
    const unexpectedModal =
      telemetry.activeDialogs.length > 0 &&
      !criteria.requiredSemanticElements?.some((el) =>
        el.toLowerCase().includes('dialog') || el.toLowerCase().includes('modal'),
      );

    // ── 3. Criteria Matching (REACHED Evaluation) ──────────────────────────
    let urlMatched = true;
    if (criteria.urlPattern) {
      urlMatched =
        typeof criteria.urlPattern === 'string'
          ? currentUrl.toLowerCase().includes(criteria.urlPattern.toLowerCase())
          : criteria.urlPattern.test(currentUrl);
    }

    // Semantic text & element checks
    const combinedText = (
      telemetry.headings.join(' ') +
      ' ' +
      telemetry.bodyTextSnippet
    ).toLowerCase();

    if (criteria.requiredSemanticElements && criteria.requiredSemanticElements.length > 0) {
      for (const req of criteria.requiredSemanticElements) {
        const reqLower = req.toLowerCase();
        const found =
          combinedText.includes(reqLower) ||
          telemetry.landmarks.some((l) => l.toLowerCase().includes(reqLower));
        if (found) {
          semanticMatches.push(req);
        }
      }
    }

    if (criteria.forbiddenSemanticElements && criteria.forbiddenSemanticElements.length > 0) {
      for (const forb of criteria.forbiddenSemanticElements) {
        const forbLower = forb.toLowerCase();
        if (combinedText.includes(forbLower)) {
          semanticViolations.push(forb);
        }
      }
    }

    const allRequiredFound =
      !criteria.requiredSemanticElements ||
      criteria.requiredSemanticElements.length === 0 ||
      semanticMatches.length === criteria.requiredSemanticElements.length;

    const noForbiddenFound = semanticViolations.length === 0;

    const itemCountSufficient =
      criteria.minimumItemCount === undefined ||
      telemetry.itemCount >= criteria.minimumItemCount;

    // ── Decision Matrix ───────────────────────────────────────────────────

    // Branch A: Deviation detected (Wrong navigation / Error page)
    if (deviationDetected) {
      status = IntermediateProgressStatus.BLOCKED;
      confidence = 0.95;
      this.consecutiveNoProgressCount++;
      feedback = `[Intermediate Progress: BLOCKED - Milestone '${milestone.expectedMilestone}' deviated: ${deviationReason}. Action did not achieve target; recovery suggested.]`;

    // Branch B: Blocking modal/overlay obscuring UI
    } else if (unexpectedModal) {
      status = IntermediateProgressStatus.BLOCKED;
      confidence = 0.9;
      this.consecutiveNoProgressCount++;
      feedback = `[Intermediate Progress: BLOCKED - Overlay/dialog (<${telemetry.activeDialogs[0]}>) is obstructing progress towards '${milestone.expectedMilestone}'. Dismiss or handle overlay first.]`;

    // Branch C: Semantic Violations (e.g. 'Out of stock' or 'Access Denied' banner)
    } else if (!noForbiddenFound) {
      status = IntermediateProgressStatus.BLOCKED;
      confidence = 0.9;
      this.consecutiveNoProgressCount++;
      feedback = `[Intermediate Progress: BLOCKED - Milestone '${milestone.expectedMilestone}' blocked by page state: found forbidden condition "${semanticViolations[0]}".]`;

    // Branch D: Active Loading State (Async / SPA settle)
    } else if (postSnapshot?.isPending || telemetry.isBusy) {
      status = IntermediateProgressStatus.IN_PROGRESS;
      confidence = 0.8;
      // Loading is active progress, not a stall
      this.consecutiveNoProgressCount = 0;
      feedback = `[Intermediate Progress: IN_PROGRESS - Page/view is actively loading for milestone '${milestone.expectedMilestone}'. Await settle.]`;

    // Branch E: Milestone REACHED!
    } else if (urlMatched && allRequiredFound && noForbiddenFound && itemCountSufficient) {
      status = IntermediateProgressStatus.REACHED;
      confidence = criteria.minimumConfidence ?? 0.95;
      this.consecutiveNoProgressCount = 0;

      const details: string[] = [];
      if (criteria.urlPattern) details.push('URL matched');
      if (semanticMatches.length > 0) details.push(`${semanticMatches.length} semantic requirement(s) confirmed`);
      if (criteria.minimumItemCount) details.push(`${telemetry.itemCount} items visible`);

      feedback = `[Intermediate Progress: REACHED - Milestone '${milestone.expectedMilestone}' achieved (${details.join(', ') || 'criteria satisfied'}).]`;
      this.advanceMilestone(milestone.stateId);

    // Branch F: Opaque surface (Canvas / Cross-origin iframe)
    } else if (
      telemetry.hasOpaqueSurface &&
      (actionVerification?.category === ActionOutcomeCategory.UNCERTAIN ||
        actionVerification?.evidence.pointElementBefore?.tag === 'canvas' ||
        actionVerification?.evidence.pointElementBefore?.tag === 'iframe')
    ) {
      status = IntermediateProgressStatus.UNCERTAIN;
      confidence = 0.4;
      feedback = `[Intermediate Progress: UNCERTAIN - Milestone '${milestone.expectedMilestone}' involves visually opaque element; host DOM signals insufficient. Rely on screenshot perception.]`;

    // Branch G: Multi-action stalled progress check
    } else {
      if (
        actionVerification?.category === ActionOutcomeCategory.NO_OP ||
        actionVerification?.category === ActionOutcomeCategory.BLOCKED
      ) {
        this.consecutiveNoProgressCount++;
      } else if (actionVerification?.category === ActionOutcomeCategory.SUCCESS) {
        // Successful mechanical action that advanced state resets consecutive no-progress
        this.consecutiveNoProgressCount = 0;
      }

      if (this.consecutiveNoProgressCount >= 3) {
        status = IntermediateProgressStatus.BLOCKED;
        confidence = 0.85;
        feedback = `[Intermediate Progress: BLOCKED - Stalled: ${this.consecutiveNoProgressCount} consecutive actions made no progress towards milestone '${milestone.expectedMilestone}'. Consider alternative approach or recovery.]`;
      } else {
        status = IntermediateProgressStatus.IN_PROGRESS;
        confidence = 0.75;
        if (actionVerification?.isLegitimateRepetition) {
          feedback = `[Intermediate Progress: IN_PROGRESS - Legitimate repeated action advancing towards milestone '${milestone.expectedMilestone}' (action ${this.actionsEvaluatedCount}).]`;
        } else if (actionVerification?.category === ActionOutcomeCategory.NO_OP) {
          feedback = `[Intermediate Progress: IN_PROGRESS - Prior action had no observable effect. Still progressing towards milestone '${milestone.expectedMilestone}'.]`;
        } else {
          feedback = `[Intermediate Progress: IN_PROGRESS - Action succeeded; advancing towards milestone '${milestone.expectedMilestone}' (action ${this.actionsEvaluatedCount}).]`;
        }
      }
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;

    return this.recordResult(
      milestone,
      status,
      confidence,
      feedback,
      {
        currentUrl,
        urlMatched,
        semanticMatches,
        semanticViolations: semanticViolations.length > 0 ? semanticViolations : undefined,
        activeDialogs: telemetry.activeDialogs,
        accessibilityState: {
          isBusy: telemetry.isBusy,
          hasModalOrDialog: telemetry.activeDialogs.length > 0,
          hasAlertOrError: telemetry.errorElements.length > 0,
          expandedElements: [],
        },
        actionOutcomeCategory: actionVerification?.category,
        actionsEvaluatedCount: this.actionsEvaluatedCount,
        consecutiveNoProgressCount: this.consecutiveNoProgressCount,
        isStalled: this.consecutiveNoProgressCount >= 3,
        deviationDetected,
        deviationReason,
      },
      durationMs,
    );
  }

  /**
   * Advances from current milestone to the next in the queue upon reaching a milestone.
   */
  private advanceMilestone(completedStateId: string): void {
    this.completedMilestones.push(completedStateId);
    if (this.milestoneQueue.length > 0) {
      this.activeMilestone = this.milestoneQueue.shift() || null;
      this.actionsEvaluatedCount = 0;
      this.consecutiveNoProgressCount = 0;
    }
  }

  /**
   * Helper to format and record verification result with bounded memory retention.
   */
  private recordResult(
    milestone: IntermediateStateContract,
    status: IntermediateProgressStatus,
    confidence: number,
    feedback: string,
    evidence: IntermediateStateEvidence,
    durationMs: number,
  ): IntermediateStateVerificationResult {
    const result: IntermediateStateVerificationResult = {
      stateId: milestone.stateId,
      milestoneDescription: milestone.expectedMilestone,
      status,
      confidence,
      feedback,
      evidence,
      durationMs,
    };

    this.history.push(result);
    if (this.history.length > this.maxHistoryLength) {
      this.history.shift();
    }

    return result;
  }
}
