/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Page } from '@agent-infra/browser';
import {
  ActionOutcomeCategory,
  ActionVerificationResult,
  ActionOutcomeEvidence,
  PreActionSnapshot,
  PostActionSnapshot,
  PointElementSnapshot,
  ElementSnapshot,
} from './types';

/**
 * Tracks consecutive actions to distinguish legitimate repeated actions
 * (e.g. repeated click on increment button producing SUCCESS)
 * from ineffective repetitive loops (repeated clicks producing NO_OP or BLOCKED).
 */
export class RepeatedActionTracker {
  private history: Array<{
    actionType: string;
    coords?: { x: number; y: number };
    category: ActionOutcomeCategory;
    timestamp: number;
  }> = [];

  private maxHistory = 20;

  public record(
    actionType: string,
    coords: { x: number; y: number } | undefined,
    category: ActionOutcomeCategory,
  ): { isLegitimateRepetition: boolean; consecutiveNoOpCount: number } {
    const now = Date.now();
    this.history.push({ actionType, coords, category, timestamp: now });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Check consecutive outcomes for this action type and coordinates
    let consecutiveSameTargetCount = 0;
    let consecutiveNoOpOrBlockedCount = 0;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      const sameAction = entry.actionType === actionType;
      const sameCoords =
        !coords ||
        !entry.coords ||
        (Math.abs(coords.x - entry.coords.x) < 5 &&
          Math.abs(coords.y - entry.coords.y) < 5);

      if (!sameAction || !sameCoords) {
        break;
      }

      consecutiveSameTargetCount++;

      if (
        entry.category === ActionOutcomeCategory.NO_OP ||
        entry.category === ActionOutcomeCategory.BLOCKED
      ) {
        consecutiveNoOpOrBlockedCount++;
      } else if (consecutiveNoOpOrBlockedCount > 0) {
        break;
      }
    }

    const isLegitimateRepetition =
      category === ActionOutcomeCategory.SUCCESS &&
      consecutiveSameTargetCount > 1;

    return {
      isLegitimateRepetition,
      consecutiveNoOpCount: consecutiveNoOpOrBlockedCount,
    };
  }

  public reset(): void {
    this.history = [];
  }
}

/**
 * Action-level outcome verifier.
 * Executes lightweight, non-intrusive DOM and browser telemetry to classify
 * action outcomes into SUCCESS, NO_OP, BLOCKED, PENDING, or UNCERTAIN.
 */
export class ActionVerifier {
  private tracker = new RepeatedActionTracker();

  /**
   * Captures the pre-action browser and DOM state.
   * Installs a lightweight MutationObserver to track DOM changes during execution.
   */
  public async capturePreSnapshot(
    page: Page,
    actionType: string,
    actionInputs: Record<string, any>,
    coords?: { x: number; y: number } | null,
  ): Promise<PreActionSnapshot> {
    const startTime = Date.now();

    try {
      const snapshot = await page.evaluate((pos) => {
        // Install a temporary mutation observer on window if supported
        try {
          if (typeof window !== 'undefined') {
            (window as any).__uiTarsMutations = 0;
            (window as any).__uiTarsMutationDetails = [];
            if ((window as any).__uiTarsObserver) {
              try {
                (window as any).__uiTarsObserver.disconnect();
              } catch {}
            }
            const observer = new MutationObserver((mutations) => {
              (window as any).__uiTarsMutations =
                ((window as any).__uiTarsMutations || 0) + mutations.length;
              for (const m of mutations) {
                if (((window as any).__uiTarsMutationDetails || []).length < 10) {
                  const target = m.target as HTMLElement;
                  (window as any).__uiTarsMutationDetails =
                    (window as any).__uiTarsMutationDetails || [];
                  (window as any).__uiTarsMutationDetails.push({
                    type: m.type,
                    targetTag: target?.tagName?.toLowerCase() || 'unknown',
                    targetId: target?.id || undefined,
                    targetClass: target?.className || undefined,
                  });
                }
              }
            });
            const root = document.documentElement || document.body;
            if (root) {
              observer.observe(root, {
                childList: true,
                attributes: true,
                characterData: true,
                subtree: true,
              });
            }
            (window as any).__uiTarsObserver = observer;
          }
        } catch {
          // Non-DOM contexts (e.g. about:blank or restricted frames)
        }

        const active = document.activeElement as HTMLElement | null;
        const activeSnapshot = {
          tag: active?.tagName?.toLowerCase() || 'body',
          id: active?.id || undefined,
          className: active?.className || undefined,
          value: (active as HTMLInputElement)?.value,
          innerText: active?.innerText?.slice(0, 100),
          disabled: (active as any)?.disabled,
          ariaDisabled: active?.getAttribute('aria-disabled') === 'true',
          ariaBusy: active?.getAttribute('aria-busy') === 'true',
          ariaExpanded: active?.getAttribute('aria-expanded') === 'true',
          isContentEditable: active?.isContentEditable,
        };

        let pointSnapshot = undefined;
        if (pos && typeof document.elementFromPoint === 'function') {
          try {
            const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
            if (el) {
              const style = window.getComputedStyle(el);
              const isPointerNone = style.pointerEvents === 'none';
              const zIndex = parseInt(style.zIndex, 10) || 0;
              const rect = el.getBoundingClientRect();

              // Check if this element acts as a modal overlay / backdrop
              const isFixedOrAbsolute =
                style.position === 'fixed' || style.position === 'absolute';
              const coversViewport =
                rect.width >= window.innerWidth * 0.8 &&
                rect.height >= window.innerHeight * 0.8;
              const classOrId = (
                (el.className || '') +
                ' ' +
                (el.id || '')
              ).toLowerCase();
              const isOverlayOrBackdrop =
                (isFixedOrAbsolute && coversViewport) ||
                classOrId.includes('overlay') ||
                classOrId.includes('backdrop') ||
                classOrId.includes('modal-mask') ||
                classOrId.includes('dialog-backdrop');

              pointSnapshot = {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                className: el.className || undefined,
                disabled: (el as any).disabled === true,
                pointerEventsNone: isPointerNone,
                isOverlayOrBackdrop,
                zIndex,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              };
            }
          } catch {
            // Element from point resolution failed
          }
        }

        return {
          url: window.location.href,
          readyState: document.readyState,
          scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
          activeElement: activeSnapshot,
          pointElement: pointSnapshot,
        };
      }, coords || null);

      return {
        ...snapshot,
        timestamp: startTime,
      };
    } catch {
      // Fallback for detached pages or early lifecycle
      return {
        url: '',
        readyState: 'complete',
        scroll: { x: 0, y: 0 },
        activeElement: { tag: 'body' },
        timestamp: startTime,
      };
    }
  }

  /**
   * Captures the post-action browser and DOM state.
   * Flushes mutations, queries changes in active element, URL, scroll, point elements.
   */
  public async capturePostSnapshot(
    page: Page,
    preSnapshot: PreActionSnapshot,
    actionType: string,
    actionInputs: Record<string, any>,
    coords?: { x: number; y: number } | null,
  ): Promise<PostActionSnapshot> {
    const postTime = Date.now();

    try {
      const snapshot = await page.evaluate((pos) => {
        let mutationCount = 0;
        let mutationSummary = '';

        try {
          if (typeof window !== 'undefined' && (window as any).__uiTarsObserver) {
            const queued = (window as any).__uiTarsObserver.takeRecords();
            if (queued && queued.length > 0) {
              (window as any).__uiTarsMutations =
                ((window as any).__uiTarsMutations || 0) + queued.length;
              for (const m of queued) {
                if (((window as any).__uiTarsMutationDetails || []).length < 10) {
                  const target = m.target as HTMLElement;
                  (window as any).__uiTarsMutationDetails = (window as any).__uiTarsMutationDetails || [];
                  (window as any).__uiTarsMutationDetails.push({
                    type: m.type,
                    targetTag: target?.tagName?.toLowerCase() || 'unknown',
                    targetId: target?.id || undefined,
                    targetClass: target?.className || undefined,
                  });
                }
              }
            }
            mutationCount = (window as any).__uiTarsMutations || 0;
            const details = (window as any).__uiTarsMutationDetails || [];
            if (details.length > 0) {
              mutationSummary = details
                .map((d: any) => `${d.type}:${d.targetTag}${d.targetId ? '#' + d.targetId : ''}`)
                .join(', ');
            }
          }
        } catch {
          // Ignore observer reading error
        }

        const active = document.activeElement as HTMLElement | null;
        const activeSnapshot = {
          tag: active?.tagName?.toLowerCase() || 'body',
          id: active?.id || undefined,
          className: active?.className || undefined,
          value: (active as HTMLInputElement)?.value,
          innerText: active?.innerText?.slice(0, 100),
          disabled: (active as any)?.disabled,
          ariaDisabled: active?.getAttribute('aria-disabled') === 'true',
          ariaBusy: active?.getAttribute('aria-busy') === 'true',
          ariaExpanded: active?.getAttribute('aria-expanded') === 'true',
          isContentEditable: active?.isContentEditable,
        };

        let pointSnapshot = undefined;
        if (pos && typeof document.elementFromPoint === 'function') {
          try {
            const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
            if (el) {
              const style = window.getComputedStyle(el);
              const isPointerNone = style.pointerEvents === 'none';
              const zIndex = parseInt(style.zIndex, 10) || 0;
              const rect = el.getBoundingClientRect();

              const isFixedOrAbsolute =
                style.position === 'fixed' || style.position === 'absolute';
              const coversViewport =
                rect.width >= window.innerWidth * 0.8 &&
                rect.height >= window.innerHeight * 0.8;
              const classOrId = (
                (el.className || '') +
                ' ' +
                (el.id || '')
              ).toLowerCase();
              const isOverlayOrBackdrop =
                (isFixedOrAbsolute && coversViewport) ||
                classOrId.includes('overlay') ||
                classOrId.includes('backdrop') ||
                classOrId.includes('modal-mask') ||
                classOrId.includes('dialog-backdrop');

              pointSnapshot = {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                className: el.className || undefined,
                disabled: (el as any).disabled === true,
                pointerEventsNone: isPointerNone,
                isOverlayOrBackdrop,
                zIndex,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              };
            }
          } catch {
            // Element from point resolution failed
          }
        }

        // Check if page or target indicates an ongoing loading / pending state
        const isAriaBusy =
          document.body?.getAttribute('aria-busy') === 'true' ||
          active?.getAttribute('aria-busy') === 'true';
        const hasSpinner =
          !!document.querySelector('[aria-busy="true"], .spinner, .loading, .busy, [role="progressbar"]');
        const isPending =
          document.readyState !== 'complete' || isAriaBusy || hasSpinner;

        let pendingReason: string | undefined = undefined;
        if (document.readyState !== 'complete') {
          pendingReason = `document.readyState=${document.readyState}`;
        } else if (isAriaBusy) {
          pendingReason = 'aria-busy="true" on target or body';
        } else if (hasSpinner) {
          pendingReason = 'Active progress or spinner element detected';
        }

        return {
          url: window.location.href,
          readyState: document.readyState,
          scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
          activeElement: activeSnapshot,
          pointElement: pointSnapshot,
          domMutationCount: mutationCount,
          domMutationSummary: mutationSummary || undefined,
          isPending,
          pendingReason,
        };
      }, coords || null);

      return {
        ...snapshot,
        timestamp: postTime,
      };
    } catch {
      return {
        url: preSnapshot.url,
        readyState: 'complete',
        scroll: { x: 0, y: 0 },
        activeElement: { tag: 'body' },
        domMutationCount: 0,
        isPending: false,
        timestamp: postTime,
      };
    }
  }

  /**
   * Detects whether a target element tag is a "visually opaque" element
   * whose interaction effects cannot be verified via DOM metadata alone.
   * Canvas, SVG, video, audio, iframe, and shadow-dom hosts cannot expose
   * internal state to MutationObserver from the outer document.
   */
  private isVerificationOpaque(tag: string | undefined): boolean {
    if (!tag) return false;
    const opaqueTags = ['canvas', 'video', 'audio', 'iframe', 'embed', 'object', 'webview'];
    return opaqueTags.includes(tag.toLowerCase());
  }

  /**
   * Determines whether observed DOM mutations are plausibly caused by the action
   * vs. unrelated background activity (timers, polling, lazy-load).
   *
   * A mutation summary mentioning the target element's tag/id is considered
   * action-correlated. A mutation summary that only mentions completely unrelated
   * elements (e.g. `attributes:head`, `characterData:script`) is considered
   * background noise. Returns:
   *  - 'correlated'  → mutations are likely caused by the action
   *  - 'background'  → mutations are likely unrelated background activity
   *  - 'unknown'     → cannot determine (no summary or no point element)
   */
  private classifyMutationSource(
    mutationSummary: string | undefined,
    pointElement: PointElementSnapshot | undefined,
    activeElement: ElementSnapshot,
  ): 'correlated' | 'background' | 'unknown' {
    if (!mutationSummary || mutationSummary.length === 0) return 'unknown';

    // Background-only tags that virtually never result from a user interaction
    const backgroundOnlyTags = ['head', 'script', 'style', 'meta', 'link', 'title'];

    const summaryLower = mutationSummary.toLowerCase();

    // Check if any non-background tag is present in the summary
    const hasNonBackgroundTag = !backgroundOnlyTags.every((bgTag) =>
      summaryLower.split(',').every((part) => part.includes(bgTag) || !part.includes(bgTag.replace(/\w/, (c) => c))),
    );

    // Check if target tag or id appears in the mutation summary
    const targetTag = (pointElement?.tag || activeElement.tag || '').toLowerCase();
    const targetId = (pointElement?.id || activeElement.id || '').toLowerCase();
    const targetClass = (pointElement?.className || activeElement.className || '').toLowerCase().split(' ')[0];

    const mentionsTarget =
      (targetTag && targetTag !== 'body' && targetTag !== 'html' && summaryLower.includes(targetTag)) ||
      (targetId && summaryLower.includes(targetId)) ||
      (targetClass && targetClass.length > 2 && summaryLower.includes(targetClass));

    // If only background-only tags mutated, classify as background
    const allPartsAreBackground = summaryLower
      .split(',')
      .map((p) => p.trim())
      .every((part) => backgroundOnlyTags.some((bg) => part.includes(bg)));

    if (allPartsAreBackground) return 'background';
    if (mentionsTarget) return 'correlated';

    // Mutations exist but we cannot determine correlation
    return 'unknown';
  }

  /**
   * Evaluates the pre- and post-action snapshots to produce a structured ActionVerificationResult.
   *
   * Classification philosophy:
   *  - SUCCESS: Observable browser evidence strongly confirms that the action had its
   *    intended mechanical effect (focus, navigation, input change, correlated DOM mutation).
   *    This does NOT imply the user's high-level GOAL was achieved.
   *  - NO_OP: Action executed but produced zero observable effect on any browser signal.
   *    Only assigned when evidence is clear and the target is not visually opaque.
   *  - BLOCKED: Action was structurally prevented (disabled target, overlay, pointer-events).
   *  - PENDING: Action triggered an asynchronous or loading state; outcome not yet settled.
   *  - UNCERTAIN: Evidence is ambiguous, contradictory, or the target element cannot expose
   *    its internal state via DOM metadata (canvas, iframe, video, etc.).
   */
  public evaluateOutcome(
    pre: PreActionSnapshot,
    post: PostActionSnapshot,
    actionType: string,
    actionInputs: Record<string, any>,
    coords?: { x: number; y: number } | null,
  ): ActionVerificationResult {
    const durationMs = post.timestamp - pre.timestamp;

    const navigationOccurred =
      pre.url.length > 0 && post.url.length > 0 && pre.url !== post.url;
    const focusChanged =
      (pre.activeElement.tag !== post.activeElement.tag ||
        pre.activeElement.id !== post.activeElement.id ||
        pre.activeElement.className !== post.activeElement.className) &&
      post.activeElement.tag !== 'body';
    const scrollDelta = {
      x: post.scroll.x - pre.scroll.x,
      y: post.scroll.y - pre.scroll.y,
    };
    const hasScroll = scrollDelta.x !== 0 || scrollDelta.y !== 0;

    const inputValBefore = pre.activeElement.value;
    const inputValAfter = post.activeElement.value;
    const inputValueChanged =
      inputValBefore !== undefined &&
      inputValAfter !== undefined &&
      inputValBefore !== inputValAfter;

    const domMutationCount = post.domMutationCount;
    const mutationSource = this.classifyMutationSource(
      post.domMutationSummary,
      pre.pointElement,
      pre.activeElement,
    );

    // Whether the action targeted a visually opaque element whose effects cannot be
    // determined from DOM metadata alone (canvas, video, iframe, etc.)
    const targetIsOpaque = this.isVerificationOpaque(pre.pointElement?.tag);

    const evidence: ActionOutcomeEvidence = {
      navigationOccurred,
      previousUrl: pre.url,
      currentUrl: post.url,
      focusChanged,
      activeElementBefore: pre.activeElement,
      activeElementAfter: post.activeElement,
      inputValueChanged,
      scrollDelta,
      domMutationCount,
      domMutationSummary: post.domMutationSummary,
      pointElementBefore: pre.pointElement,
      pointElementAfter: post.pointElement,
      isPendingDetected: post.isPending,
      visualDeltaScore: post.visualDeltaScore,
    };

    let category = ActionOutcomeCategory.UNCERTAIN;
    let confidence = 0.5;
    let feedback = '';

    // ── BLOCKED checks ────────────────────────────────────────────────────────
    // Evaluate structural prevention before any DOM/navigation analysis.
    const isTargetDisabled =
      pre.pointElement?.disabled === true ||
      pre.activeElement.disabled === true ||
      pre.pointElement?.pointerEventsNone === true;

    const isCoveredByOverlay =
      pre.pointElement?.isOverlayOrBackdrop === true &&
      !actionInputs?.allowOverlayClick;

    if (isTargetDisabled) {
      category = ActionOutcomeCategory.BLOCKED;
      confidence = 0.95;
      evidence.isBlockedByOverlay = false;
      feedback =
        `Target element <${pre.pointElement?.tag || pre.activeElement.tag}> is disabled ` +
        `or has pointer-events: none. Action could not interact. ` +
        `[Note: This confirms a UI obstacle; it does not indicate goal failure.]`;
    } else if (isCoveredByOverlay) {
      category = ActionOutcomeCategory.BLOCKED;
      confidence = 0.95;
      evidence.isBlockedByOverlay = true;
      feedback =
        `Action was intercepted by an overlay/backdrop barrier ` +
        `<${pre.pointElement?.tag} class="${pre.pointElement?.className || ''}">. ` +
        `Target was obscured. [Note: Overlay may need to be dismissed before goal can proceed.]`;

    // ── CLICK / DOUBLE_CLICK / RIGHT_CLICK ────────────────────────────────────
    } else if (
      actionType === 'click' ||
      actionType === 'left_click' ||
      actionType === 'left_single' ||
      actionType === 'right_click' ||
      actionType === 'double_click' ||
      actionType === 'left_double'
    ) {
      if (navigationOccurred) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 1.0;
        feedback = `Click produced observable effect: page navigated from ${pre.url} to ${post.url}. [Task progress must be verified separately.]`;
      } else if (post.isPending) {
        category = ActionOutcomeCategory.PENDING;
        confidence = 0.9;
        feedback = `Click triggered an asynchronous/loading state (${post.pendingReason || 'pending indicators detected'}). Await resolution before verifying outcome.`;
      } else if (targetIsOpaque) {
        // Canvas, video, iframe, etc. — opaque elements whose internal state cannot be observed
        // via host DOM metadata. Even if focus shifted to the container (e.g. iframe), internal
        // consequences are unknown.
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.4;
        feedback =
          `Click on visually opaque element <${pre.pointElement?.tag}> at (${coords?.x}, ${coords?.y}): ` +
          `no DOM, focus, scroll, or navigation signal is available for this element type. ` +
          `Outcome is UNCERTAIN — visual screenshot comparison required.`;
      } else if (focusChanged) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.95;
        feedback =
          `Click produced observable effect: focus shifted to ` +
          `<${post.activeElement.tag}${post.activeElement.id ? '#' + post.activeElement.id : ''}>.`;
      } else if (domMutationCount > 0 && mutationSource === 'correlated') {
        // DOM mutations plausibly caused by the action
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.9;
        feedback =
          `Click produced observable effect: ${domMutationCount} DOM mutation(s) correlated with target ` +
          `(${post.domMutationSummary || 'nodes updated'}). [UI reacted; task goal not yet verified.]`;
      } else if (domMutationCount > 0 && mutationSource === 'background') {
        // Mutations exist but appear unrelated to the click target
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.5;
        feedback =
          `Click on <${pre.pointElement?.tag || 'element'}> at (${coords?.x}, ${coords?.y}): ` +
          `${domMutationCount} DOM mutation(s) detected but appear to be background activity ` +
          `(${post.domMutationSummary}), not correlated with the click target. ` +
          `Outcome is UNCERTAIN — visual verification recommended.`;
      } else if (domMutationCount > 0 && mutationSource === 'unknown') {
        // Cannot determine mutation origin — surface as uncertain
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.6;
        feedback =
          `Click on <${pre.pointElement?.tag || 'element'}> at (${coords?.x}, ${coords?.y}): ` +
          `${domMutationCount} DOM mutation(s) detected but mutation-to-target correlation ` +
          `is indeterminate (${post.domMutationSummary || 'no summary'}). ` +
          `Outcome is UNCERTAIN.`;
      } else if (hasScroll) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.9;
        feedback = `Click produced observable effect: viewport scrolled by (${scrollDelta.x}, ${scrollDelta.y})px.`;
      } else {
        // Clear NO_OP: non-opaque element, zero signals of any kind
        category = ActionOutcomeCategory.NO_OP;
        confidence = 0.9;
        feedback =
          `Click produced no observable browser effect: target <${pre.pointElement?.tag || 'element'}> ` +
          `at (${coords?.x}, ${coords?.y}) returned 0 DOM mutations, 0 URL change, and 0 focus shift. ` +
          `[Confidence reduced from 0.95 to 0.9 to account for rare async effects.]`;
      }

    // ── TYPE ──────────────────────────────────────────────────────────────────
    } else if (actionType === 'type') {
      const typedContent = actionInputs?.content || '';
      if (inputValueChanged) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 1.0;
        feedback = `Type produced observable effect: input value updated from "${inputValBefore || ''}" to "${inputValAfter || ''}".`;
      } else if (domMutationCount > 0 && mutationSource !== 'background') {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.85;
        feedback = `Type produced observable effect: DOM mutated (${domMutationCount} mutation(s)) — likely contenteditable or live-search region.`;
      } else if (focusChanged) {
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.6;
        feedback = `Type shifted focus to <${post.activeElement.tag}> but input value was not confirmed to change.`;
      } else if (targetIsOpaque) {
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.4;
        feedback =
          `Type into visually opaque element <${pre.activeElement.tag}>: ` +
          `no input-value or DOM signal is verifiable. Outcome is UNCERTAIN.`;
      } else {
        category = ActionOutcomeCategory.NO_OP;
        confidence = 0.9;
        feedback = `Type produced no observable effect: target <${pre.activeElement.tag}> value unchanged after attempting to type "${typedContent}".`;
      }

    // ── SCROLL ────────────────────────────────────────────────────────────────
    } else if (actionType === 'scroll') {
      if (hasScroll) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 1.0;
        feedback = `Scroll produced observable effect: viewport shifted by (${scrollDelta.x}, ${scrollDelta.y})px.`;
      } else if (domMutationCount > 0) {
        // Virtual/nested scroll: container scrolls but window.scrollY unchanged
        // DOM mutations from list virtualization = strong evidence of scroll effect
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.85;
        feedback =
          `Scroll produced observable effect: ${domMutationCount} DOM mutation(s) detected ` +
          `(${post.domMutationSummary || 'virtual or nested scroll container update'}) ` +
          `without window scroll delta — consistent with virtualized list or nested scroll container.`;
      } else {
        category = ActionOutcomeCategory.NO_OP;
        confidence = 0.85;
        feedback =
          `Scroll produced no observable effect: window scroll delta (0, 0) and no DOM mutations. ` +
          `Page may already be at the scroll boundary, or scroll target may be a fixed container.`;
      }

    // ── NAVIGATE / GOTO ───────────────────────────────────────────────────────
    } else if (actionType === 'goto' || actionType === 'navigate') {
      if (navigationOccurred) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 1.0;
        feedback = `Navigation produced observable effect: URL changed to ${post.url}.`;
      } else if (post.readyState !== 'complete') {
        category = ActionOutcomeCategory.PENDING;
        confidence = 0.9;
        feedback = `Navigation pending: readyState is ${post.readyState}.`;
      } else {
        category = ActionOutcomeCategory.NO_OP;
        confidence = 0.85;
        feedback = `Navigation produced no observable effect: page remained at ${post.url}.`;
      }

    // ── WAIT ─────────────────────────────────────────────────────────────────
    } else if (actionType === 'wait') {
      category = ActionOutcomeCategory.SUCCESS;
      confidence = 1.0;
      feedback = `Wait completed (${actionInputs?.time || 5000}ms). DOM mutations during wait: ${domMutationCount}.`;

    // ── TERMINAL ACTIONS ─────────────────────────────────────────────────────
    } else if (
      actionType === 'finished' ||
      actionType === 'call_user' ||
      actionType === 'user_stop'
    ) {
      category = ActionOutcomeCategory.SUCCESS;
      confidence = 1.0;
      feedback = `Terminal action ${actionType} completed. [Goal satisfaction must be verified separately from this action-level signal.]`;

    // ── HOTKEY / KEY / GENERIC ────────────────────────────────────────────────
    } else {
      if (navigationOccurred || focusChanged || inputValueChanged || hasScroll) {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.9;
        feedback = `Action ${actionType} produced observable browser effect (navigation=${navigationOccurred}, focusChanged=${focusChanged}, scroll=${hasScroll}).`;
      } else if (domMutationCount > 0 && mutationSource === 'correlated') {
        category = ActionOutcomeCategory.SUCCESS;
        confidence = 0.85;
        feedback = `Action ${actionType} produced correlated DOM mutation(s) (${domMutationCount}).`;
      } else if (domMutationCount > 0 && mutationSource !== 'correlated') {
        category = ActionOutcomeCategory.UNCERTAIN;
        confidence = 0.55;
        feedback = `Action ${actionType}: ${domMutationCount} DOM mutation(s) detected but source is uncertain (${post.domMutationSummary || 'no summary'}).`;
      } else {
        category = ActionOutcomeCategory.NO_OP;
        confidence = 0.75;
        feedback = `Action ${actionType} produced no observable browser state changes.`;
      }
    }

    // ── Repeated action tracking ──────────────────────────────────────────────
    const { isLegitimateRepetition, consecutiveNoOpCount } = this.tracker.record(
      actionType,
      coords ? { x: coords.x, y: coords.y } : undefined,
      category,
    );

    if (consecutiveNoOpCount >= 2) {
      feedback +=
        ` [RECOVERY HINT: ${consecutiveNoOpCount} consecutive ${category} results at the same target. ` +
        `UI-TARS should reconsider its approach: try an alternate target, dismiss blocking UI, or verify the goal differently.]`;
    } else if (isLegitimateRepetition) {
      feedback += ` [LEGITIMATE REPETITION: repeated successful ${actionType} at the same target — incremental progress is ongoing.]`;
    }

    return {
      category,
      confidence,
      evidence,
      feedback,
      actionType,
      actionInputs,
      durationMs,
      isLegitimateRepetition,
      consecutiveNoOpCount,
    };
  }

  public reset(): void {
    this.tracker.reset();
  }
}
