/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page } from '@agent-infra/browser';
import {
  GoalCategory,
  FinalGoalStatus,
  FinalGoalContract,
  FinalGoalVerificationResult,
  FinalGoalEvaluationContext,
  FinalGoalEvidence,
  ActionOutcomeCategory,
} from './types';

/**
 * FinalGoalVerifier (Milestone 3)
 *
 * Implements evidence-grounded final-goal verification before UI-TARS terminates execution.
 *
 * Key Capabilities:
 *  1. Intercepts UI-TARS finished() to prevent premature termination.
 *  2. Evaluates actual goal satisfaction across EXTRACTION, STATE_CHANGE, and CONFIRMATION categories.
 *  3. Verifies universal browser signals (URL, headings, landmarks, dialogs, alerts) without site-specific selectors.
 *  4. Detects media playback vs. advertisements and buffering states.
 *  5. Handles asynchronous settle, pending confirmation loaders, and visually opaque interfaces.
 *  6. Prevents infinite loops via bounded verification attempts with terminal escalation (call_user).
 *  7. Enforces sensitive / irreversible action authorization to prevent duplicate charges or destruction.
 *  8. Rejects empty/ambiguous finished() calls when no evidence or contract exists.
 */
export class FinalGoalVerifier {
  private activeContract: FinalGoalContract | null = null;
  private rejectionCount = 0;
  private readonly defaultMaxAttempts = 3;

  /**
   * Sets the active final-goal verification contract.
   */
  public setGoalContract(contract: FinalGoalContract | null): void {
    this.activeContract = contract;
    this.rejectionCount = 0;
  }

  /**
   * Returns the current active contract.
   */
  public getGoalContract(): FinalGoalContract | null {
    return this.activeContract;
  }

  /**
   * Resets rejection counters while preserving contract.
   */
  public reset(): void {
    this.rejectionCount = 0;
  }

  /**
   * Completely clears the active contract and resets rejection counters.
   */
  public clear(): void {
    this.activeContract = null;
    this.rejectionCount = 0;
  }

  /**
   * Returns current consecutive rejection count.
   */
  public getRejectionCount(): number {
    return this.rejectionCount;
  }

  /**
   * Infers a fallback goal contract from user instruction when no explicit contract is provided.
   */
  public inferContractFromInstruction(instruction: string): FinalGoalContract {
    const text = (instruction || '').toLowerCase().trim();

    let category = GoalCategory.CONFIRMATION;
    const extractionKeywords = [
      'what is',
      'what are',
      'find',
      'extract',
      'get the',
      'price of',
      'how much',
      'search for',
      'look up',
      'tell me',
      'who is',
      'where is',
    ];
    const stateChangeKeywords = [
      'buy',
      'purchase',
      'order',
      'book',
      'submit',
      'create',
      'delete',
      'remove',
      'save',
      'update',
      'register',
      'sign up',
      'add to cart',
      'checkout',
      'fill',
      'post',
      'send',
    ];

    if (extractionKeywords.some((k) => text.includes(k))) {
      category = GoalCategory.EXTRACTION;
    } else if (stateChangeKeywords.some((k) => text.includes(k))) {
      category = GoalCategory.STATE_CHANGE;
    }

    return {
      goalDescription: `Inferred ${category} contract for: ${instruction.slice(0, 80)}`,
      category,
      userInstruction: instruction,
      expectedGoalType: category,
      criteria: {
        category,
        description: `Inferred ${category} contract for: ${instruction.slice(0, 80)}`,
        minimumContentLength:
          category === GoalCategory.EXTRACTION ? 10 : undefined,
      },
      maxRejections: this.defaultMaxAttempts,
      maxVerificationAttempts: this.defaultMaxAttempts,
    };
  }

  /**
   * Evaluates completion evidence when UI-TARS attempts finished().
   */
  public async evaluate(params: {
    page?: Page | null;
    prediction?: any;
    actionVerification?: any;
    lastIntermediateState?: any;
    userInstruction?: string;
  }): Promise<FinalGoalVerificationResult> {
    const t0 = performance.now();
    const { page, prediction, actionVerification, lastIntermediateState } =
      params;

    const thought = (prediction?.thought || '').trim();
    const instruction =
      params.userInstruction || this.activeContract?.userInstruction || '';

    // If no contract is configured, infer one from the instruction
    const contract =
      this.activeContract || this.inferContractFromInstruction(instruction);
    const criteria = contract.criteria || {};
    const category =
      contract.category ||
      criteria.category ||
      contract.expectedGoalType ||
      GoalCategory.CONFIRMATION;
    const maxAttempts =
      contract.maxRejections ||
      contract.maxVerificationAttempts ||
      this.defaultMaxAttempts;

    // ── 1. Telemetry Sampling Pass ─────────────────────────────────────────
    let currentUrl = '';
    let headings: string[] = [];
    let landmarks: string[] = [];
    let activeDialogs: string[] = [];
    let errorBanners: string[] = [];
    let isPending = false;
    let hasOpaqueSurface = false;
    let itemCount = 0;
    let bodySnippet = '';
    let mediaState: FinalGoalEvidence['mediaState'] = {
      hasMediaElement: false,
      isPlaying: false,
      isBuffering: false,
      isAdPlaying: false,
      currentTime: 0,
      duration: 0,
    };

    if (page) {
      try {
        currentUrl = typeof page.url === 'function' ? page.url() : '';
        const sampled = await page.evaluate(() => {
          const hdgs = Array.from(
            document.querySelectorAll('h1, h2, h3, [role="heading"]'),
          )
            .map((el) => (el.textContent || '').trim().slice(0, 100))
            .filter((t) => t.length > 0);

          const ldmks = Array.from(
            document.querySelectorAll(
              'main, [role="main"], [role="search"], [role="navigation"], [role="dialog"], [role="alert"]',
            ),
          ).map(
            (el) =>
              el.tagName.toLowerCase() +
              (el.getAttribute('role')
                ? `[role="${el.getAttribute('role')}"]`
                : ''),
          );

          const dlgs = Array.from(
            document.querySelectorAll(
              'dialog[open], [role="dialog"][aria-modal="true"], .modal.show, .modal-backdrop, .overlay.active',
            ),
          ).map(
            (el) =>
              el.tagName.toLowerCase() +
              (el.id ? '#' + el.id : '') +
              (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          );

          const errs = Array.from(
            document.querySelectorAll(
              '[role="alert"], .error-banner, .alert-danger, .error-message, .error-text, .alert-error',
            ),
          )
            .map((el) => (el.textContent || '').trim().slice(0, 100))
            .filter((t) => t.length > 0);

          const busy =
            document.body?.getAttribute('aria-busy') === 'true' ||
            !!document.querySelector(
              '[aria-busy="true"], .spinner, .loading, .busy, [role="progressbar"]',
            );

          const opaque = !!document.querySelector('canvas, iframe');
          const count = document.querySelectorAll(
            '[role="listitem"], article, table tbody tr, .card, .item, .result-item',
          ).length;

          const snippet = (document.body?.innerText || '').slice(0, 5000);

          // Universal media/video telemetry
          const video = document.querySelector(
            'video',
          ) as HTMLVideoElement | null;
          const audio = document.querySelector(
            'audio',
          ) as HTMLAudioElement | null;
          const media = video || audio;

          let mediaInfo = {
            hasMediaElement: false,
            isPlaying: false,
            isBuffering: false,
            isAdPlaying: false,
            currentTime: 0,
            duration: 0,
          };

          if (media) {
            const isPlaying =
              !media.paused && !media.ended && media.currentTime > 0;
            const isBuffering = media.readyState < 3 && !media.paused;

            // Universal advertisement detection
            const adOverlay = !!document.querySelector(
              '.ad-showing, .video-ads, [class*="ad-container"], .ytp-ad-player-overlay, [aria-label*="advertisement" i], [aria-label*="sponsored" i]',
            );

            mediaInfo = {
              hasMediaElement: true,
              isPlaying,
              isBuffering,
              isAdPlaying: adOverlay,
              currentTime: Math.round(media.currentTime * 10) / 10,
              duration: Math.round((media.duration || 0) * 10) / 10,
            };
          }

          return {
            hdgs,
            ldmks,
            dlgs,
            errs,
            busy,
            opaque,
            count,
            snippet,
            mediaInfo,
          };
        });

        headings = sampled.hdgs;
        landmarks = sampled.ldmks;
        activeDialogs = sampled.dlgs;
        errorBanners = sampled.errs;
        isPending = sampled.busy;
        hasOpaqueSurface = sampled.opaque;
        itemCount = sampled.count;
        bodySnippet = sampled.snippet;
        mediaState = sampled.mediaInfo;
      } catch {
        // Fallback if page detached
      }
    }

    const context: FinalGoalEvaluationContext = {
      page,
      prediction,
      actionVerification,
      lastIntermediateState,
      userInstruction: instruction,
      thought,
      url: currentUrl,
      headings,
      landmarks,
      bodySnippet,
      activeDialogs,
      errorBanners,
      mediaState,
      isPending,
      hasOpaqueSurface,
    };

    let status = FinalGoalStatus.UNFULFILLED;
    let confidence = 0.5;
    let feedback = '';
    const extractedMatches: string[] = [];
    const missingRequirements: string[] = [];
    let deviationDetected = false;
    let deviationReason: string | undefined = undefined;

    // ── 2. Check Custom Evaluator Hook if provided ──────────────────────────
    if (
      typeof criteria.customEvaluator === 'function' ||
      typeof contract.evaluateCompletion === 'function'
    ) {
      const evalFn =
        criteria.customEvaluator || (contract.evaluateCompletion as any);
      try {
        const customRes = await evalFn(context);
        if (customRes.satisfied || customRes.goalSatisfied) {
          this.rejectionCount = 0;
          return this.buildResult(
            FinalGoalStatus.VERIFIED,
            category,
            customRes.confidence ?? 0.95,
            customRes.feedback ||
              '[Final Goal Verification: VERIFIED - Custom goal criteria completely satisfied.]',
            context,
            [],
            [],
            false,
            maxAttempts,
            performance.now() - t0,
          );
        } else {
          this.rejectionCount++;
          const isEscalation = this.rejectionCount >= maxAttempts;
          return this.buildResult(
            isEscalation
              ? FinalGoalStatus.BLOCKED
              : customRes.status || FinalGoalStatus.UNFULFILLED,
            category,
            customRes.confidence ?? 0.85,
            isEscalation
              ? `[Final Goal Verification: BLOCKED - Maximum verification attempts (${maxAttempts}) exceeded without satisfying goal criteria. Escalating to user assistance to prevent infinite loop.]`
              : customRes.feedback ||
                  `[Final Goal Verification: UNFULFILLED - ${customRes.reason || 'Custom criteria unmet'}. Continue execution.]`,
            context,
            [],
            customRes.unmetRequirements || [
              customRes.reason || 'Custom criteria unmet',
            ],
            isEscalation,
            maxAttempts,
            performance.now() - t0,
          );
        }
      } catch {
        // Fall through to deterministic evaluation
      }
    }

    // ── 3. Universal Error / Deviation Detection ───────────────────────────
    if (
      (/\/(404|500|error|access-denied|blocked|captcha)(\/|\?|$)/i.test(
        currentUrl,
      ) ||
        currentUrl.includes('error-page')) &&
      category !== GoalCategory.CONFIRMATION
    ) {
      deviationDetected = true;
      deviationReason = `Navigated to error/barrier URL '${currentUrl}'`;
    }

    if (errorBanners.length > 0) {
      deviationDetected = true;
      deviationReason = `Page displays error alert: "${errorBanners[0]}"`;
    }

    // ── 4. Category-Specific Verification ──────────────────────────────────
    switch (category) {
      // ══════════════════════════════════════════════════════════════════════
      // Category A: EXTRACTION
      // ══════════════════════════════════════════════════════════════════════
      case GoalCategory.EXTRACTION: {
        const minLen = criteria.minimumContentLength ?? 10;
        const substantiveText = thought.length >= minLen;

        if (!thought || !substantiveText) {
          missingRequirements.push(
            'substantive extracted information in final answer',
          );
        }

        // Check required fields in thought
        if (
          criteria.requiredExtractedFields &&
          criteria.requiredExtractedFields.length > 0
        ) {
          for (const field of criteria.requiredExtractedFields) {
            const hasField = thought
              .toLowerCase()
              .includes(field.toLowerCase());
            if (hasField) {
              extractedMatches.push(field);
            } else {
              missingRequirements.push(`extracted field '${field}'`);
            }
          }
        }

        // Check regex patterns
        if (
          criteria.extractedRegexPatterns &&
          criteria.extractedRegexPatterns.length > 0
        ) {
          for (const pattern of criteria.extractedRegexPatterns) {
            const reg =
              typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
            if (reg.test(thought)) {
              extractedMatches.push(String(pattern));
            } else {
              missingRequirements.push(`match pattern '${pattern}'`);
            }
          }
        }

        if (missingRequirements.length === 0) {
          status = FinalGoalStatus.VERIFIED;
          confidence = 0.95;
          feedback = `[Final Goal Verification: VERIFIED - Extraction goal satisfied (${extractedMatches.length} field(s) confirmed in final response).]`;
        } else {
          status = FinalGoalStatus.UNFULFILLED;
          confidence = 0.9;
          feedback = `[Final Goal Verification: UNFULFILLED - Missing requested extraction data: [${missingRequirements.join(', ')}]. Obtain information before finishing.]`;
        }
        break;
      }

      // ══════════════════════════════════════════════════════════════════════
      // Category B: STATE_CHANGE
      // ══════════════════════════════════════════════════════════════════════
      case GoalCategory.STATE_CHANGE: {
        // 1. Sensitive operation authorization check (Requirement 12)
        if (criteria.requiresExplicitApproval && !criteria.isPreAuthorized) {
          status = FinalGoalStatus.BLOCKED;
          confidence = 0.99;
          feedback =
            '[Final Goal Verification: BLOCKED - Sensitive/irreversible operation requires explicit user authorization before completion. Awaiting authorization.]';
          break;
        }

        // 2. Error banners or failure semantics
        if (
          criteria.failureSemanticElements &&
          criteria.failureSemanticElements.length > 0
        ) {
          const combined = (
            headings.join(' ') +
            ' ' +
            bodySnippet
          ).toLowerCase();
          for (const failEl of criteria.failureSemanticElements) {
            if (combined.includes(failEl.toLowerCase())) {
              deviationDetected = true;
              deviationReason = `State change failed: found error condition "${failEl}"`;
              break;
            }
          }
        }

        if (deviationDetected) {
          status = FinalGoalStatus.BLOCKED;
          confidence = 0.95;
          feedback = `[Final Goal Verification: BLOCKED - ${deviationReason}. State change did not succeed; resolve obstacle.]`;
          break;
        }

        // 3. Delayed settle / Active loading state
        if (isPending) {
          status = FinalGoalStatus.UNFULFILLED;
          confidence = 0.85;
          feedback =
            '[Final Goal Verification: UNFULFILLED - Confirmation is pending; view is actively loading/processing. Await completion before finishing.]';
          break;
        }

        // 4. URL matching
        let urlMatched = true;
        if (criteria.successUrlPattern) {
          urlMatched =
            typeof criteria.successUrlPattern === 'string'
              ? currentUrl
                  .toLowerCase()
                  .includes(criteria.successUrlPattern.toLowerCase())
              : criteria.successUrlPattern.test(currentUrl);
          if (!urlMatched) {
            missingRequirements.push(
              `URL matching '${criteria.successUrlPattern}' (current: '${currentUrl}')`,
            );
          }
        }

        // 5. Semantic confirmation elements
        const combinedText = (
          headings.join(' ') +
          ' ' +
          bodySnippet
        ).toLowerCase();
        if (
          criteria.successSemanticElements &&
          criteria.successSemanticElements.length > 0
        ) {
          for (const req of criteria.successSemanticElements) {
            const found =
              combinedText.includes(req.toLowerCase()) ||
              landmarks.some((l) =>
                l.toLowerCase().includes(req.toLowerCase()),
              );
            if (!found) {
              missingRequirements.push(`confirmation landmark '${req}'`);
            }
          }
        }

        // 6. Minimum item count
        if (
          criteria.minimumItemCount !== undefined &&
          itemCount < criteria.minimumItemCount
        ) {
          missingRequirements.push(
            `minimum ${criteria.minimumItemCount} items (found: ${itemCount})`,
          );
        }

        if (missingRequirements.length === 0 && urlMatched) {
          status = FinalGoalStatus.VERIFIED;
          confidence = 0.95;
          feedback =
            '[Final Goal Verification: VERIFIED - State change confirmed: intended mutations and confirmation signals verified.]';
        } else if (hasOpaqueSurface && missingRequirements.length > 0) {
          // Opaque canvas / iframe surface
          status = FinalGoalStatus.UNCERTAIN;
          confidence = 0.45;
          feedback =
            '[Final Goal Verification: UNCERTAIN - Target interface contains visually opaque element; host DOM signals insufficient to verify completion. Re-evaluating visual evidence.]';
        } else {
          status = FinalGoalStatus.UNFULFILLED;
          confidence = 0.9;
          feedback = `[Final Goal Verification: UNFULFILLED - State change not yet confirmed: missing [${missingRequirements.join(', ')}]. Continue execution.]`;
        }
        break;
      }

      // ══════════════════════════════════════════════════════════════════════
      // Category C: CONFIRMATION (including Media Playback & Dynamic States)
      // ══════════════════════════════════════════════════════════════════════
      case GoalCategory.CONFIRMATION:
      default: {
        // 1. Media playback evaluation (Requirement 8 & Testing Requirement)
        const needsMedia =
          criteria.mediaPlaybackRequired ||
          (criteria as any).requireMediaPlayback;
        if (needsMedia) {
          if (!mediaState.hasMediaElement) {
            missingRequirements.push('active media player element');
            status = FinalGoalStatus.UNFULFILLED;
            confidence = 0.9;
            feedback =
              '[Final Goal Verification: UNFULFILLED - No active media player found on page. Locate and open target media.]';
            break;
          }

          const noAds = criteria.prohibitAdPlayback !== false;
          if (noAds && mediaState.isAdPlaying) {
            status = FinalGoalStatus.UNFULFILLED;
            confidence = 0.95;
            feedback =
              '[Final Goal Verification: UNFULFILLED - Media player is currently displaying an advertisement, not target content. Await completion or skip ad.]';
            break;
          }

          if (mediaState.isBuffering) {
            status = FinalGoalStatus.UNFULFILLED;
            confidence = 0.8;
            feedback =
              '[Final Goal Verification: UNFULFILLED - Media stream is currently buffering. Await playback settle before finishing.]';
            break;
          }

          if (!mediaState.isPlaying) {
            status = FinalGoalStatus.UNFULFILLED;
            confidence = 0.9;
            feedback =
              '[Final Goal Verification: UNFULFILLED - Media player is paused or has not commenced playback. Play target media before finishing.]';
            break;
          }

          // Video is playing target media!
          status = FinalGoalStatus.VERIFIED;
          confidence = 0.95;
          feedback = `[Final Goal Verification: VERIFIED - Media playback confirmed (playing, t=${mediaState.currentTime}s, ad-free).]`;
          break;
        }

        // 2. Observable state presence
        if (
          criteria.requiredObservableState &&
          criteria.requiredObservableState.length > 0
        ) {
          const combined = (
            headings.join(' ') +
            ' ' +
            bodySnippet
          ).toLowerCase();
          for (const obs of criteria.requiredObservableState) {
            if (!combined.includes(obs.toLowerCase())) {
              missingRequirements.push(`observable condition '${obs}'`);
            }
          }
        }

        // 3. Fallback check for missing or ambiguous criteria (Requirement 15)
        if (
          (!criteria.requiredObservableState ||
            criteria.requiredObservableState.length === 0) &&
          headings.length === 0 &&
          thought.length < 5
        ) {
          status = FinalGoalStatus.UNFULFILLED;
          confidence = 0.85;
          feedback =
            '[Final Goal Verification: UNFULFILLED - Finished called without observable evidence or substantive report. Confirm findings before finishing.]';
          break;
        }

        if (
          hasOpaqueSurface &&
          headings.length === 0 &&
          !criteria.requiredObservableState
        ) {
          status = FinalGoalStatus.UNCERTAIN;
          confidence = 0.5;
          feedback =
            '[Final Goal Verification: UNCERTAIN - Target interface contains visually opaque element (canvas/iframe); host DOM signals insufficient to verify completion. Re-evaluating visual evidence.]';
        } else if (missingRequirements.length === 0) {
          status = FinalGoalStatus.VERIFIED;
          confidence = 0.92;
          feedback =
            '[Final Goal Verification: VERIFIED - Requested condition/information verified on screen.]';
        } else {
          status = FinalGoalStatus.UNFULFILLED;
          confidence = 0.88;
          feedback = `[Final Goal Verification: UNFULFILLED - Missing verified observation: [${missingRequirements.join(', ')}]. Continue task.]`;
        }
        break;
      }
    }

    // ── 5. Bounded Rejection & Terminal Escalation (Requirement 11) ──────────
    let terminalEscalation = false;
    if (status !== FinalGoalStatus.VERIFIED) {
      this.rejectionCount++;
      if (this.rejectionCount >= maxAttempts) {
        status = FinalGoalStatus.BLOCKED;
        terminalEscalation = true;
        feedback = `[Final Goal Verification: BLOCKED - Maximum verification attempts (${maxAttempts}) exceeded without satisfying goal criteria. Escalating to user assistance to prevent infinite loop.]`;
      }
    } else {
      this.rejectionCount = 0;
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;

    return this.buildResult(
      status,
      category,
      confidence,
      feedback,
      context,
      extractedMatches,
      missingRequirements,
      terminalEscalation,
      maxAttempts,
      durationMs,
    );
  }

  /**
   * Helper to construct a structured FinalGoalVerificationResult
   */
  private buildResult(
    status: FinalGoalStatus,
    category: GoalCategory,
    confidence: number,
    feedback: string,
    context: FinalGoalEvaluationContext,
    extractedMatches: string[],
    missingRequirements: string[],
    terminalEscalation: boolean,
    maxAttempts: number,
    durationMs: number,
  ): FinalGoalVerificationResult {
    return {
      status,
      category,
      confidence,
      feedback,
      terminalEscalation,
      rejectionCount: this.rejectionCount,
      durationMs,
      evidence: {
        currentUrl: context.url || '',
        category,
        headings: context.headings || [],
        landmarks: context.landmarks || [],
        bodySnippet: (context.bodySnippet || '').slice(0, 500),
        activeDialogs: context.activeDialogs || [],
        errorBanners: context.errorBanners || [],
        extractedMatches,
        missingRequirements,
        mediaState: context.mediaState,
        isPending: !!context.isPending,
        hasOpaqueSurface: !!context.hasOpaqueSurface,
        attemptNumber: this.rejectionCount,
        maxAttempts,
      },
    };
  }
}
