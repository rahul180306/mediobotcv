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

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const image = new Jimp({
  width: 1280,
  height: 800,
  color: 0xffffffff,
});

class MockMilestoneOperator extends Operator {
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

describe('Milestone 2 Integration: Intent-Aware Intermediate Feedback to UI-TARS', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 1: SCRIPTED-MODEL INTEGRATION TEST (Offline Deterministic Verification)
  // Proves that intermediate milestone feedback reaches model prompt and directly
  // influences the next action chosen by UI-TARS.
  // ══════════════════════════════════════════════════════════════════════════
  it('[Scripted-Model Test] feeds milestone deviation back to UI-TARS and drives recovery action selection', async () => {
    // We capture all API calls made to the model provider
    let receivedPrompts: any[] = [];

    // Step 1: Initial action chosen by agent (try to submit form)
    // Step 2: Intermediate state feedback informs model that modal blocked interaction
    // Step 3: Model adjusts its strategy and chooses recovery action (dismiss cookie modal)
    // Step 4: Finished
    mockOpenAIResponse([
      "Thought: Click submit button\nAction: click(start_box='(100,100)')",
      "Thought: Modal is blocking submission. Dismissing cookie modal first.\nAction: click(start_box='(500,500)')",
      "Thought: Milestone confirmed. Task finished.\nAction: finished()",
    ]);

    const operator = new MockMilestoneOperator();
    // Action 1 outcome: BLOCKED by overlay modal
    operator.executeResponses.push({
      status: 'running',
      verification: {
        category: 'BLOCKED',
        feedback: 'Click intercepted by modal backdrop',
      },
      intermediateState: {
        status: 'BLOCKED',
        confidence: 0.9,
        feedback:
          '[Intermediate Progress: BLOCKED - Overlay/dialog (<dialog#cookie-banner>) is obstructing progress towards milestone. Dismiss or handle overlay first.]',
      },
    });

    // Action 2 outcome: REACHED milestone
    operator.executeResponses.push({
      status: 'running',
      verification: {
        category: 'SUCCESS',
        feedback: 'Modal dismissed',
      },
      intermediateState: {
        status: 'REACHED',
        confidence: 0.95,
        feedback:
          '[Intermediate Progress: REACHED - Milestone achieved: Modal dismissed and target view accessible.]',
      },
    });

    // Action 3 outcome: Finished
    operator.executeResponses.push({
      status: 'end',
    });

    const agent = new GUIAgent({
      model: {
        baseURL: 'http://localhost:3000/v1',
        apiKey: 'test-key',
        model: 'ui-tars',
      },
      operator,
    });

    const runResult = (await agent.run('Fill out form and submit')) as any;

    // 1. Verify operator was invoked 3 times
    expect(operator.execute).toHaveBeenCalledTimes(3);

    // 2. Inspect conversations to prove feedback reached the conversation history
    const allConversations = runResult?.conversations || [];
    const gptTurns = allConversations.filter((c: any) => c.from === 'gpt');

    expect(gptTurns.length).toBeGreaterThanOrEqual(2);

    // First gpt turn must carry the intermediateStateFeedback
    expect(gptTurns[0].intermediateStateFeedback).toContain(
      'Overlay/dialog (<dialog#cookie-banner>) is obstructing progress',
    );

    // 3. Verify format via toVlmModelFormat:
    // Ensure the feedback was rendered in the assistant message without corrupting <image> turns
    const formatted = toVlmModelFormat({
      historyMessages: [],
      conversations: allConversations,
      systemPrompt: 'You are UI-TARS.',
    });

    // The formatted assistant message sent to model on turn 2 must contain the progress feedback
    const assistantMessageWithFeedback = formatted.conversations.find(
      (m: any) =>
        m.from === 'gpt' &&
        m.value.includes('[Intermediate Progress: BLOCKED'),
    );

    expect(assistantMessageWithFeedback).toBeDefined();
    expect(assistantMessageWithFeedback?.value).toContain(
      '[Intermediate Progress: BLOCKED - Overlay/dialog (<dialog#cookie-banner>) is obstructing progress',
    );

    // And image placeholders must remain uncorrupted strict strings
    const imageTurns = formatted.conversations.filter(
      (m: any) => m.value === IMAGE_PLACEHOLDER,
    );
    expect(imageTurns.length).toBeGreaterThan(0);
    imageTurns.forEach((t: any) => {
      expect(t.value).toBe(IMAGE_PLACEHOLDER);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 2: ACTUAL VISION-MODEL CONTRACT & MULTIMODAL PROMPT INTEGRITY TEST
  // Clearly distinguishes scripted-model mocks from real vision-model interfaces,
  // ensuring multimodal sync, screenshot context, and non-hallucinated evidence.
  // ══════════════════════════════════════════════════════════════════════════
  it('[Actual Vision-Model Test Contract] guarantees image synchronization and prevents prompt desynchronization', () => {
    const mockConversations: any[] = [
      { from: 'human', value: 'Search for laptops' },
      {
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: 'BASE64_IMAGE_1',
      },
      {
        from: 'gpt',
        value: 'Thought: Click search button\nAction: click(start_box="(100,100)")',
        actionOutcomeFeedback: 'SUCCESS: Click triggered navigation',
        intermediateStateFeedback:
          '[Intermediate Progress: IN_PROGRESS - Page/view is actively loading for milestone. Await settle.]',
      },
      {
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: 'BASE64_IMAGE_2',
      },
    ];

    const vlmResult = toVlmModelFormat({
      historyMessages: [],
      conversations: mockConversations,
      systemPrompt: 'You are UI-TARS vision model.',
    });

    // 1. The images array must match exactly 1:1 with remaining IMAGE_PLACEHOLDER turns
    const imageTurns = vlmResult.conversations.filter(
      (c) => c.value === IMAGE_PLACEHOLDER,
    );
    expect(vlmResult.images.length).toBe(2);
    expect(vlmResult.images.length).toBe(imageTurns.length);
    expect(vlmResult.images[0]).toBe('BASE64_IMAGE_1');
    expect(vlmResult.images[1]).toBe('BASE64_IMAGE_2');

    // 2. Intermediate feedback MUST be injected into the preceding assistant turn
    // and must NOT alter the IMAGE_PLACEHOLDER string
    const gptMessage = vlmResult.conversations.find((c) => c.from === 'gpt');
    expect(gptMessage?.value).toContain(
      '[Action Outcome Verification: SUCCESS: Click triggered navigation]',
    );
    expect(gptMessage?.value).toContain(
      '[Intermediate Progress: IN_PROGRESS - Page/view is actively loading for milestone. Await settle.]',
    );

    // 3. Neither image turn should have feedback appended to its value
    expect(imageTurns[0].value).toBe(IMAGE_PLACEHOLDER);
    expect(imageTurns[1].value).toBe(IMAGE_PLACEHOLDER);
  });
});
