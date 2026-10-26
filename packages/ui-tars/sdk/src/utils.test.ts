// /packages/sdk/src/utils.test.ts
/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  parseBoxToScreenCoords,
  processVlmParams,
  toVlmModelFormat,
} from './utils';
import { DEFAULT_FACTORS } from './constants';
import { IMAGE_PLACEHOLDER, MAX_IMAGE_LENGTH } from '@ui-tars/shared/constants';

describe('parseBoxToScreenCoords', () => {
  it('should correctly parse single point coordinates', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '[0.5,0.5]',
      screenWidth: 1000,
      screenHeight: 800,
      factors: DEFAULT_FACTORS,
    });
    expect(result).toEqual({
      x: Math.round(0.5 * 1000 * DEFAULT_FACTORS[0]) / DEFAULT_FACTORS[0],
      y: Math.round(0.5 * 800 * DEFAULT_FACTORS[1]) / DEFAULT_FACTORS[1],
    });
  });

  it('should correctly parse single point coordinates by default factors', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '[0.5,0.5]',
      screenWidth: 1000,
      screenHeight: 800,
    });
    expect(result).toEqual({
      x: Math.round(0.5 * 1000 * DEFAULT_FACTORS[0]) / DEFAULT_FACTORS[0],
      y: Math.round(0.5 * 800 * DEFAULT_FACTORS[1]) / DEFAULT_FACTORS[1],
    });
  });

  it('should correctly parse box coordinates', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '[0.2,0.3,0.4,0.5]',
      screenWidth: 1000,
      screenHeight: 800,
      factors: DEFAULT_FACTORS,
    });
    expect(result).toEqual({
      x: Math.round(0.3 * 1000 * DEFAULT_FACTORS[0]) / DEFAULT_FACTORS[0], // (0.2 + 0.4) / 2 = 0.3
      y: Math.round(0.4 * 800 * DEFAULT_FACTORS[1]) / DEFAULT_FACTORS[1], // (0.3 + 0.5) / 2 = 0.4
    });
  });

  it('should handle whitespace in input string', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '[ 0.5 , 0.5 ]',
      screenWidth: 1000,
      screenHeight: 800,
      factors: DEFAULT_FACTORS,
    });
    expect(result).toEqual({
      x: Math.round(0.5 * 1000 * DEFAULT_FACTORS[0]) / DEFAULT_FACTORS[0],
      y: Math.round(0.5 * 800 * DEFAULT_FACTORS[1]) / DEFAULT_FACTORS[1],
    });
  });

  it('should handle integer coordinates', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '[1,1,2,2]',
      screenWidth: 1000,
      screenHeight: 800,
      factors: DEFAULT_FACTORS,
    });
    expect(result).toEqual({
      x: Math.round(1.5 * 1000 * DEFAULT_FACTORS[0]) / DEFAULT_FACTORS[0],
      y: Math.round(1.5 * 800 * DEFAULT_FACTORS[1]) / DEFAULT_FACTORS[1],
    });
  });

  it('should handle empty box string', () => {
    const result = parseBoxToScreenCoords({
      boxStr: '',
      screenWidth: 1000,
      screenHeight: 800,
      factors: DEFAULT_FACTORS,
    });
    expect(result).toEqual({
      x: null,
      y: null,
    });
  });
});

describe('processVlmParams', () => {
  it('should correctly process vlm params', () => {
    const result = processVlmParams(
      [
        {
          from: 'human',
          value: 'system prompt',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
      ],
      ['data:image/png;base64,image_1'],
      MAX_IMAGE_LENGTH,
    );
    expect(result).toEqual({
      conversations: [
        {
          from: 'human',
          value: 'system prompt',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
      ],
      images: ['data:image/png;base64,image_1'],
    });
  });

  it('should correctly process vlm params with max image length', () => {
    const result = processVlmParams(
      [
        {
          from: 'human',
          value: 'system prompt',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
        {
          from: 'gpt',
          value: 'assistant response',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
        {
          from: 'gpt',
          value: 'assistant response',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
      ],
      [
        'data:image/png;base64,image_1',
        'data:image/png;base64,image_2',
        'data:image/png;base64,image_3',
      ],
      2,
    );
    expect(result).toEqual({
      conversations: [
        {
          from: 'human',
          value: 'system prompt',
        },
        {
          from: 'gpt',
          value: 'assistant response',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
        {
          from: 'gpt',
          value: 'assistant response',
        },
        {
          from: 'human',
          value: IMAGE_PLACEHOLDER,
        },
      ],
      images: [
        'data:image/png;base64,image_2',
        'data:image/png;base64,image_3',
      ],
    });
  });
});

describe('toVlmModelFormat', () => {
  it('should correctly convert to vlm model format normal', () => {
    const result = toVlmModelFormat({
      historyMessages: [
        {
          from: 'human',
          value: '12345-0',
        },
        {
          from: 'gpt',
          value: '67890-0',
        },
        {
          from: 'human',
          value: '12345-1',
        },
        {
          from: 'gpt',
          value: '67890-1',
        },
      ],
      conversations: [
        {
          from: 'human',
          value: 'user-instruction',
        },
      ],
      systemPrompt: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')

## User Instruction
`,
    });
    expect(result).toEqual({
      conversations: [
        {
          from: 'human',
          value: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')

## History Messages
human: 12345-0
assistant: 67890-0
human: 12345-1
assistant: 67890-1

## User Instruction
user-instruction`,
        },
      ],
      images: [],
    });
  });

  it('should correctly convert to vlm model format no \\n', () => {
    const result = toVlmModelFormat({
      historyMessages: [
        {
          from: 'human',
          value: '12345-0',
        },
        {
          from: 'gpt',
          value: '67890-0',
        },
        {
          from: 'human',
          value: '12345-1',
        },
        {
          from: 'gpt',
          value: '67890-1',
        },
      ],
      conversations: [
        {
          from: 'human',
          value: 'user-instruction',
        },
      ],
      systemPrompt: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')

## User Instruction`,
    });
    expect(result).toEqual({
      conversations: [
        {
          from: 'human',
          value: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')

## History Messages
human: 12345-0
assistant: 67890-0
human: 12345-1
assistant: 67890-1

## User Instruction
user-instruction`,
        },
      ],
      images: [],
    });
  });

  it('should correctly convert to vlm model format no instruction title', () => {
    const result = toVlmModelFormat({
      historyMessages: [
        {
          from: 'human',
          value: '12345-0',
        },
        {
          from: 'gpt',
          value: '67890-0',
        },
        {
          from: 'human',
          value: '12345-1',
        },
        {
          from: 'gpt',
          value: '67890-1',
        },
      ],
      conversations: [
        {
          from: 'human',
          value: 'user-instruction',
        },
      ],
      systemPrompt: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')
`,
    });
    expect(result).toEqual({
      conversations: [
        {
          from: 'human',
          value: `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Examples
Thought: Write your thoughts here in English, your thinking style should follow the Thought Examples above...

Action: click(point='<point>10 20</point>')

## History Messages
human: 12345-0
assistant: 67890-0
human: 12345-1
assistant: 67890-1

## User Instruction
user-instruction`,
        },
      ],
      images: [],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Milestone 1C Hardening: actionOutcomeFeedback prompt alignment regression
// Verifies that IMAGE_PLACEHOLDER values are NEVER corrupted by feedback injection.
// A regression here would cause convertToOpenAIMessages to misclassify image turns
// as text messages, breaking screenshot-to-prompt alignment.
// ══════════════════════════════════════════════════════════════════════════

describe('toVlmModelFormat — actionOutcomeFeedback IMAGE_PLACEHOLDER alignment', () => {
  it('[HARDEN-1C] feedback is NOT injected into image placeholder turns', () => {
    const conversations: any[] = [
      { from: 'human', value: 'What do you see?' },
      {
        from: 'gpt',
        value: 'I see a button.',
        actionOutcomeFeedback: 'SUCCESS: click focused element.',
      },
      {
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: 'base64-screenshot-data',
        // Feedback on an image turn must NOT be appended to the value
        actionOutcomeFeedback: 'SUCCESS: click focused element.',
      },
    ];

    const result = toVlmModelFormat({
      historyMessages: [],
      conversations,
      systemPrompt: 'You are UI-TARS.',
    });

    // Image turn value must remain exactly IMAGE_PLACEHOLDER
    const imageTurns = result.conversations.filter((c) => c.value === IMAGE_PLACEHOLDER);
    expect(imageTurns).toHaveLength(1);

    // images array must be populated correctly
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toBe('base64-screenshot-data');

    // The gpt turn (non-image) should receive the feedback suffix
    const gptTurn = result.conversations.find((c) => c.from === 'gpt');
    expect(gptTurn?.value).toContain('[Action Outcome Verification:');
    expect(gptTurn?.value).toContain('SUCCESS: click focused element.');
  });

  it('[HARDEN-1C] all IMAGE_PLACEHOLDER turns preserved when multiple screenshots have feedback', () => {
    const conversations: any[] = [
      { from: 'human', value: 'Search for laptops' },
      ...Array.from({ length: 4 }, (_, i) => ({
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: `base64-${i}`,
        actionOutcomeFeedback: i > 0 ? `outcome-${i}` : undefined,
      })),
    ];

    const result = toVlmModelFormat({
      historyMessages: [],
      conversations,
      systemPrompt: 'You are UI-TARS.',
    });

    // All image turns (index >= 1) must remain exactly IMAGE_PLACEHOLDER
    const imageTurns = result.conversations.filter((c) => c.value === IMAGE_PLACEHOLDER);
    expect(imageTurns).toHaveLength(4);

    // Screenshots must remain in order
    expect(result.images).toHaveLength(4);
    expect(result.images[0]).toBe('base64-0');
    expect(result.images[3]).toBe('base64-3');
  });
});
