/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Logger } from '@agent-infra/logger';
import type { BrowserInterface, Page, BrowserType } from '@agent-infra/browser';
import type { ScreenshotOutput, ExecuteParams } from '@ui-tars/sdk/core';
import { StatusEnum } from '@ui-tars/sdk';
export { StatusEnum };
export type { Page, ScreenshotOutput, ExecuteParams };
export type ParsedPrediction = ExecuteParams['parsedPrediction'];

/**
 * Search engine options
 */
export enum SearchEngine {
  GOOGLE = 'google',
  BAIDU = 'baidu',
  BING = 'bing',
}

/**
 * Configuration options for the BrowserOperator
 */
export interface BrowserOperatorOptions {
  /**
   * Browser instance to control
   */
  browser: BrowserInterface;

  browserType: BrowserType;

  /**
   * Optional logger instance
   */
  logger?: Logger;

  /**
   * Whether to highlight clickable elements before taking screenshots
   * @default false
   */
  highlightClickableElements?: boolean;

  /**
   * Whether to show action info in the browser window
   * @default false
   */
  showActionInfo?: boolean;

  /**
   * Whether to show water flow effect during screenshots
   * @default false
   */
  showWaterFlow?: boolean;

  /**
   * Callback triggered when an operator action is performed
   * @deprecated Will be removed when `@ui-tars/sdk` supports hooks natively
   */
  onOperatorAction?: (prediction: ParsedPrediction) => Promise<void>;

  /**
   * Callback triggered when a screenshot is taken
   */
  onScreenshot?: (screenshot: ScreenshotOutput, page: Page) => Promise<void>;

  /**
   * Callback triggered when a final answer is received
   */
  onFinalAnswer?: (finalAnswer: string) => Promise<void>;

  /**
   * Optional initial intermediate state contracts/milestones
   */
  intermediateMilestones?: IntermediateStateContract[];

  /**
   * Optional initial active page
   */
  page?: Page;

  /**
   * Optional final-goal contract for Milestone 3 verification
   */
  finalGoalContract?: FinalGoalContract;
}

import type {
  ActionVerificationResult,
  IntermediateStateVerificationResult,
  IntermediateStateContract,
  FinalGoalVerificationResult,
  FinalGoalContract,
  FinalGoalCriteria,
  FinalGoalEvidence,
} from './verification';
import {
  IntermediateProgressStatus,
  GoalCategory,
  FinalGoalStatus,
} from './verification';

export { IntermediateProgressStatus, GoalCategory, FinalGoalStatus };
export type {
  IntermediateStateContract,
  IntermediateStateVerificationResult,
  FinalGoalContract,
  FinalGoalVerificationResult,
  FinalGoalCriteria,
  FinalGoalEvidence,
};

/**
 * Output of BrowserOperator execute
 */
export interface BrowserExecuteOutput {
  status: StatusEnum;
  startX: number | null;
  startY: number | null;
  action_inputs?: Record<string, any>;
  verification?: ActionVerificationResult;
  intermediateState?: IntermediateStateVerificationResult;
  finalGoalVerification?: FinalGoalVerificationResult;
}
