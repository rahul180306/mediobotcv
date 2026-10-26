/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GUIAgent } from '../src/GUIAgent';
import { Operator } from '../src/types';
import { Jimp } from 'jimp';
import { mockOpenAIResponse } from './testKits/index';
import { toVlmModelFormat } from '../src/utils';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { StatusEnum } from '@ui-tars/shared/types';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const image = new Jimp({
  width: 1280,
  height: 800,
  color: 0xffffffff,
});

class MockFinalGoalOperator extends Operator {
  public executeCalls: any[] = [];
  public executeResponses: any[] = [];

  screenshot = vi.fn().mockImplementation(async () => {
    const buffer = await image.getBuffer('image/png');
    return {
      base64: buffer.toString('base64'),
      width: 1280,
      height: 800,
      scaleFactor: 1,
    };
  });

  execute = vi.fn().mockImplementation(async (params) => {
    this.executeCalls.push(params);
    const resp = this.executeResponses.shift() || { status: 'running' };
    return resp;
  });
}

describe('Milestone 3 Integration: Evidence-Grounded Final-Goal Verification Loop', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 1: SCRIPTED-MODEL CLOSED LOOP INTERCEPTION & AUTONOMOUS RECOVERY
  // Note: This deterministic test verifies the control flow, feedback injection,
  // and interception mechanism. It does NOT claim or prove real vision-model
  // intelligence, which requires a live configured vision model.
  // ══════════════════════════════════════════════════════════════════════════
  it('[Scripted-Model Test] intercepts premature finished(), feeds evidence-grounded feedback, and accepts verified completion', async () => {
    // Sequence of model decisions:
    // 1. Model prematurely declares finished() without confirmation number
    // 2. Model receives [Final Goal Verification: UNFULFILLED...] feedback in prompt
    // 3. Model executes recovery action to locate confirmation number
    // 4. Model re-issues finished() with the extracted confirmation number
    mockOpenAIResponse([
      'Thought: Order submitted, task is complete.\nAction: finished()',
      "Thought: Final goal was rejected because confirmation number is missing. Clicking view receipt.\nAction: click(start_box='(200,200)')",
      'Thought: Extracted confirmation_number: CONF-889912. Task verified.\nAction: finished()',
    ]);

    const operator = new MockFinalGoalOperator();

    // Turn 1: Premature finished() rejected by FinalGoalVerifier
    operator.executeResponses.push({
      status: 'running',
      finalGoalVerification: {
        status: 'UNFULFILLED',
        category: 'EXTRACTION',
        confidence: 0.9,
        feedback:
          '[Final Goal Verification: UNFULFILLED - Missing requested extraction data: [confirmation_number]. Obtain information before finishing.]',
        rejectionCount: 1,
        terminalEscalation: false,
      },
    });

    // Turn 2: Recovery click action executed
    operator.executeResponses.push({
      status: 'running',
      verification: {
        category: 'SUCCESS',
        feedback: 'Clicked receipt link, receipt details visible',
      },
    });

    // Turn 3: Verified finished() accepted by FinalGoalVerifier
    operator.executeResponses.push({
      status: 'end',
      finalGoalVerification: {
        status: 'VERIFIED',
        category: 'EXTRACTION',
        confidence: 0.98,
        feedback:
          '[Final Goal Verification: VERIFIED - Requested extraction data obtained and validated.]',
        rejectionCount: 0,
        terminalEscalation: false,
      },
    });

    const agent = new GUIAgent({
      model: {
        baseURL: 'http://localhost:3000/v1',
        apiKey: 'test-key',
        model: 'ui-tars',
      },
      operator,
    });

    const runResult = (await agent.run(
      'Book flight and obtain confirmation_number',
    )) as any;

    // 1. Verify operator was invoked 3 times (interception prevented early termination at turn 1)
    expect(operator.execute).toHaveBeenCalledTimes(3);
    expect(runResult.status).toBe(StatusEnum.END);

    // 2. Verify that premature finished() feedback was recorded on the first GPT turn
    const gptTurns = runResult.conversations.filter(
      (c: any) => c.from === 'gpt',
    );
    expect(gptTurns.length).toBe(3);

    expect(gptTurns[0].finalGoalFeedback).toContain(
      'Missing requested extraction data: [confirmation_number]',
    );

    // 3. Verify that toVlmModelFormat correctly formats [Final Goal Verification: ...]
    const formatted = toVlmModelFormat({
      historyMessages: [],
      conversations: runResult.conversations,
      systemPrompt: 'You are UI-TARS.',
    });

    const turn1Formatted = formatted.conversations.find(
      (m: any) =>
        m.from === 'gpt' &&
        m.value.includes('[Final Goal Verification: UNFULFILLED'),
    );

    expect(turn1Formatted).toBeDefined();
    expect(turn1Formatted?.value).toContain(
      '[Final Goal Verification: UNFULFILLED - Missing requested extraction data: [confirmation_number]',
    );

    // 4. Verify image tokens remained intact without desynchronization
    const imageTurns = formatted.conversations.filter(
      (m: any) => m.value === IMAGE_PLACEHOLDER,
    );
    expect(imageTurns.length).toBeGreaterThan(0);
    imageTurns.forEach((t: any) => expect(t.value).toBe(IMAGE_PLACEHOLDER));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Test 2: BOUNDED REJECTION & USER-ASSISTANCE TERMINAL ESCALATION
  // Prevents endless rejection loops by escalating to CALL_USER after limit.
  // ══════════════════════════════════════════════════════════════════════════
  it('[Terminal Escalation Test] escalates to CALL_USER when repeated finished() calls exceed threshold', async () => {
    // Model insists on finished() 3 times without fulfilling the goal
    mockOpenAIResponse([
      'Thought: Done attempt 1.\nAction: finished()',
      'Thought: Retrying finish attempt 2.\nAction: finished()',
      'Thought: Retrying finish attempt 3.\nAction: finished()',
    ]);

    const operator = new MockFinalGoalOperator();

    // Rejection 1
    operator.executeResponses.push({
      status: 'running',
      finalGoalVerification: {
        status: 'UNFULFILLED',
        feedback: 'Goal unfulfilled attempt 1',
        rejectionCount: 1,
        terminalEscalation: false,
      },
    });

    // Rejection 2
    operator.executeResponses.push({
      status: 'running',
      finalGoalVerification: {
        status: 'UNFULFILLED',
        feedback: 'Goal unfulfilled attempt 2',
        rejectionCount: 2,
        terminalEscalation: false,
      },
    });

    // Rejection 3 -> Terminal escalation
    operator.executeResponses.push({
      status: 'running',
      finalGoalVerification: {
        status: 'BLOCKED',
        feedback:
          '[Final Goal Verification: BLOCKED - Maximum verification attempts (3) exceeded without satisfying goal criteria. Escalating to user assistance to prevent infinite loop.]',
        rejectionCount: 3,
        terminalEscalation: true,
      },
    });

    const agent = new GUIAgent({
      model: {
        baseURL: 'http://localhost:3000/v1',
        apiKey: 'test-key',
        model: 'ui-tars',
      },
      operator,
    });

    const runResult = (await agent.run('Complete unfulfillable task')) as any;

    // Agent must escalate to CALL_USER rather than looping indefinitely
    expect(operator.execute).toHaveBeenCalledTimes(3);
    expect(runResult.status).toBe(StatusEnum.CALL_USER);
  });
});
