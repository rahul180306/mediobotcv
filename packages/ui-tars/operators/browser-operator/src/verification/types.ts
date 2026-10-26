/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classification category for action-level execution outcomes.
 */
export enum ActionOutcomeCategory {
  /** Observable evidence strongly confirms intended action effect (navigation, focus, input mutation, scroll). */
  SUCCESS = 'SUCCESS',
  /** Action executed with zero observable DOM, URL, focus, scroll, or visual reaction (e.g. unreactive element). */
  NO_OP = 'NO_OP',
  /** Action was prevented from reaching target by overlay, backdrop, pointer-events: none, or disabled attribute. */
  BLOCKED = 'BLOCKED',
  /** Action triggered an asynchronous or loading state (readyState incomplete, network requests, aria-busy). */
  PENDING = 'PENDING',
  /** Ambiguous or conflicting signals (e.g. background mutated without clear target element reaction). */
  UNCERTAIN = 'UNCERTAIN',
}

export interface ElementSnapshot {
  tag: string;
  id?: string;
  className?: string;
  value?: string;
  innerText?: string;
  disabled?: boolean;
  ariaDisabled?: boolean;
  ariaBusy?: boolean;
  ariaExpanded?: boolean;
  pointerEvents?: string;
  zIndex?: number;
  isContentEditable?: boolean;
}

export interface PointElementSnapshot {
  tag: string;
  id?: string;
  className?: string;
  disabled: boolean;
  pointerEventsNone: boolean;
  isOverlayOrBackdrop: boolean;
  zIndex: number;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface PreActionSnapshot {
  url: string;
  readyState: string;
  scroll: { x: number; y: number };
  activeElement: ElementSnapshot;
  pointElement?: PointElementSnapshot;
  timestamp: number;
}

export interface PostActionSnapshot {
  url: string;
  readyState: string;
  scroll: { x: number; y: number };
  activeElement: ElementSnapshot;
  pointElement?: PointElementSnapshot;
  domMutationCount: number;
  domMutationSummary?: string;
  isPending: boolean;
  pendingReason?: string;
  visualDeltaScore?: number;
  timestamp: number;
}

export interface ActionOutcomeEvidence {
  navigationOccurred: boolean;
  previousUrl: string;
  currentUrl: string;
  focusChanged: boolean;
  activeElementBefore: ElementSnapshot;
  activeElementAfter: ElementSnapshot;
  inputValueChanged?: boolean;
  scrollDelta: { x: number; y: number };
  domMutationCount: number;
  domMutationSummary?: string;
  pointElementBefore?: PointElementSnapshot;
  pointElementAfter?: PointElementSnapshot;
  isBlockedByOverlay?: boolean;
  isPendingDetected?: boolean;
  visualDeltaScore?: number;
}

export interface ActionVerificationResult {
  category: ActionOutcomeCategory;
  confidence: number; // 0.0 to 1.0
  evidence: ActionOutcomeEvidence;
  feedback: string;
  actionType: string;
  actionInputs: Record<string, any>;
  durationMs: number;
  isLegitimateRepetition?: boolean;
  consecutiveNoOpCount?: number;
}

/**
 * -----------------------------------------------------------------------------
 * Milestone 2: Intermediate-State Verification Contracts & Types
 * -----------------------------------------------------------------------------
 */

/**
 * Task progress status for intermediate milestone evaluation.
 */
export enum IntermediateProgressStatus {
  /** Milestone prerequisites or triggering actions have not yet commenced. */
  NOT_STARTED = 'NOT_STARTED',
  /** Actions are underway and progress is observed, but milestone is not yet settled or reached. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Observable browser and DOM evidence confirms the milestone objective has been achieved. */
  REACHED = 'REACHED',
  /** Execution is obstructed by a modal overlay, disabled elements, error page, or stalled actions. */
  BLOCKED = 'BLOCKED',
  /** Evidence is ambiguous, contradictory, or hidden inside visually opaque elements (canvas, iframe). */
  UNCERTAIN = 'UNCERTAIN',
}

/**
 * Context provided to an intermediate state evaluator.
 */
export interface IntermediateEvaluationContext {
  url: string;
  previousUrl: string;
  actionType: string;
  actionInputs: Record<string, any>;
  actionVerification?: ActionVerificationResult;
  elapsedActions: number;
  consecutiveNoProgressCount: number;
  semanticHeadings?: string[];
  semanticLandmarks?: string[];
  activeDialogs?: string[];
  errorBanners?: string[];
  itemCount?: number;
  isPending?: boolean;
  isOpaqueSurface?: boolean;
}

/**
 * Evaluation criteria for an intermediate milestone.
 */
export interface IntermediateStateEvaluationCriteria {
  /** URL pattern or substring expected upon reaching the milestone */
  urlPattern?: string | RegExp;
  /** Disallowed URL patterns (e.g. error, 404, login wall) that indicate deviation */
  forbiddenUrlPatterns?: (string | RegExp)[];
  /** Semantic texts or elements expected to be visible (e.g. 'results', 'cart', heading text) */
  requiredSemanticElements?: string[];
  /** Prohibited semantic elements or texts (e.g. 'Out of stock', 'Access Denied') */
  forbiddenSemanticElements?: string[];
  /** Minimum number of semantic items (cards, list items, rows) */
  minimumItemCount?: number;
  /** Minimum confidence threshold required to classify as REACHED */
  minimumConfidence?: number;
  /** Custom evaluator function for domain-specific criteria */
  customEvaluator?: (context: IntermediateEvaluationContext) => Promise<{
    reached: boolean;
    confidence: number;
    deviationReason?: string;
  }>;
}

/**
 * Intermediate-State Verification Contract (Milestone 2)
 * Assesses whether a sequence of actions has produced an expected intermediate milestone
 * without requiring website-specific selectors or hardcoded workflows.
 */
export interface IntermediateStateContract {
  stateId: string;
  expectedMilestone: string;
  prerequisiteActions?: string[];
  evaluationCriteria?: IntermediateStateEvaluationCriteria;
  evaluate?(context: IntermediateEvaluationContext): Promise<{
    reached: boolean;
    confidence: number;
    deviationReason?: string;
  }>;
}

export interface IntermediateStateEvidence {
  currentUrl: string;
  urlMatched?: boolean;
  semanticMatches: string[];
  semanticViolations?: string[];
  activeDialogs?: string[];
  accessibilityState?: {
    isBusy: boolean;
    hasModalOrDialog: boolean;
    hasAlertOrError: boolean;
    expandedElements: string[];
  };
  actionOutcomeCategory?: ActionOutcomeCategory;
  actionsEvaluatedCount: number;
  consecutiveNoProgressCount: number;
  isStalled: boolean;
  deviationDetected?: boolean;
  deviationReason?: string;
}

export interface IntermediateStateVerificationResult {
  stateId: string;
  milestoneDescription: string;
  status: IntermediateProgressStatus;
  confidence: number; // 0.0 to 1.0
  feedback: string;
  evidence: IntermediateStateEvidence;
  durationMs: number;
}


/**
 * Goal Categories for Milestone 3 Final-Goal Verification
 */
export enum GoalCategory {
  /** User requested specific information to be extracted and returned */
  EXTRACTION = 'EXTRACTION',
  /** User requested a persistent mutation (form submission, settings change, order, action) */
  STATE_CHANGE = 'STATE_CHANGE',
  /** User requested verification of a state, condition, or observation */
  CONFIRMATION = 'CONFIRMATION',
}

/**
 * Verification outcome for final-goal completion
 */
export enum FinalGoalStatus {
  /** Observable evidence confirms the user's primary goal has been completely satisfied */
  VERIFIED = 'VERIFIED',
  /** Goal requirements are not yet satisfied (missing extraction, pending confirmation, unsubmitted action) */
  UNFULFILLED = 'UNFULFILLED',
  /** Evidence is ambiguous, contradictory, or hidden inside opaque elements (canvas, cross-origin iframe) */
  UNCERTAIN = 'UNCERTAIN',
  /** Completion is obstructed by an error page, fatal validation barrier, or sensitive authorization */
  BLOCKED = 'BLOCKED',
}

/**
 * Detailed evaluation criteria for final-goal verification
 */
export interface FinalGoalCriteria {
  /** Target goal category */
  category?: GoalCategory;
  /** Human-readable explanation of what constitutes verified completion */
  description?: string;

  // ── EXTRACTION Criteria ────────────────────────────────────────────────
  /** Key field names or concepts that must be reported in the thought or final answer */
  requiredExtractedFields?: string[];
  /** Regex patterns that extracted content must match */
  extractedRegexPatterns?: (string | RegExp)[];
  /** Minimum length of extracted substantive content */
  minimumContentLength?: number;

  // ── STATE_CHANGE Criteria ──────────────────────────────────────────────
  /** URL pattern indicating successful mutation (e.g. '/confirmed', '/success', '#/order-complete') */
  successUrlPattern?: string | RegExp;
  /** Semantic phrases or headings that confirm success (e.g. 'Order confirmed', 'Changes saved') */
  successSemanticElements?: string[];
  /** Error phrases that indicate mutation failure (e.g. 'Submission failed', 'Invalid card', 'Error 500') */
  failureSemanticElements?: string[];
  /** Minimum number of items that must exist after state change */
  minimumItemCount?: number;

  // ── CONFIRMATION Criteria ──────────────────────────────────────────────
  /** State conditions that must be confirmed present on screen */
  requiredObservableState?: string[];

  // ── Media / Dynamic States Criteria ────────────────────────────────────
  /** If true, verifies active media playback (<video> or <audio> playing, not paused, currentTime > 0) */
  mediaPlaybackRequired?: boolean;
  /** Alias for mediaPlaybackRequired */
  requireMediaPlayback?: boolean;
  /** If true, verifies that playback is not an advertisement (e.g. .ad-showing, .video-ads) */
  prohibitAdPlayback?: boolean;

  // ── Sensitive / Irreversible Action Protection ─────────────────────────
  /** If true, requires explicit caller authorization before state-changing completion is accepted */
  requiresExplicitApproval?: boolean;
  /** Whether sensitive operation has been authorized */
  isPreAuthorized?: boolean;

  // ── Custom Evaluator Hook ──────────────────────────────────────────────
  customEvaluator?: (context: FinalGoalEvaluationContext) => Promise<{
    satisfied: boolean;
    confidence?: number;
    status?: FinalGoalStatus;
    feedback?: string;
    reason?: string;
  }>;
}

/**
 * Universal browser and session telemetry context provided to FinalGoalVerifier
 */
export interface FinalGoalEvaluationContext {
  page?: any;
  prediction?: any;
  actionVerification?: ActionVerificationResult;
  lastIntermediateState?: IntermediateStateVerificationResult;
  userInstruction?: string;
  thought?: string;
  url?: string;
  headings?: string[];
  landmarks?: string[];
  bodySnippet?: string;
  activeDialogs?: string[];
  errorBanners?: string[];
  mediaState?: {
    hasMediaElement: boolean;
    isPlaying: boolean;
    isBuffering: boolean;
    isAdPlaying: boolean;
    currentTime: number;
    duration: number;
  };
  isPending?: boolean;
  hasOpaqueSurface?: boolean;
}

/**
 * Evidence package bundled with the final-goal verification result
 */
export interface FinalGoalEvidence {
  currentUrl: string;
  category: GoalCategory;
  headings: string[];
  landmarks: string[];
  bodySnippet: string;
  activeDialogs: string[];
  errorBanners: string[];
  extractedMatches: string[];
  missingRequirements: string[];
  mediaState?: {
    hasMediaElement: boolean;
    isPlaying: boolean;
    isBuffering: boolean;
    isAdPlaying: boolean;
    currentTime: number;
    duration: number;
  };
  isPending: boolean;
  hasOpaqueSurface: boolean;
  attemptNumber: number;
  maxAttempts: number;
  isStalled?: boolean;
  deviationDetected?: boolean;
  deviationReason?: string;
}

/**
 * Outcome of the FinalGoalVerifier evaluation
 */
export interface FinalGoalVerificationResult {
  status: FinalGoalStatus;
  category: GoalCategory;
  confidence: number; // 0.0 to 1.0
  feedback: string;
  evidence: FinalGoalEvidence;
  /** Set to true when maximum rejection attempts have been exceeded and user intervention is needed */
  terminalEscalation?: boolean;
  /** Number of times finished() has been rejected in this session */
  rejectionCount?: number;
  durationMs: number;
}

/**
 * Final-Goal Verification Contract
 * Specifies the user's primary goal, its category, and evidence criteria.
 */
export interface FinalGoalContract {
  goalId?: string;
  goalDescription?: string;
  category?: GoalCategory;
  userInstruction?: string;
  expectedGoalType?: GoalCategory;
  criteria?: FinalGoalCriteria;
  maxRejections?: number;
  maxVerificationAttempts?: number; // Default: 3
  evaluateCompletion?: (context: FinalGoalEvaluationContext) => Promise<{
    goalSatisfied: boolean;
    confidence: number;
    unmetRequirements?: string[];
    feedback?: string;
  }>;
}

