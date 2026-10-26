/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { OpenAI } from 'openai';
import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';

const t = initIpc.create();

export const settingRoute = t.router({
  checkVLMResponseApiSupport: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
    }>()
    .handle(async ({ input }) => {
      try {
        const openai = new OpenAI({
          apiKey: input.apiKey,
          baseURL: input.baseUrl,
        });
        const result = await openai.responses.create({
          model: input.modelName,
          input: 'return 1+1=?',
          stream: false,
        });
        console.log('result', result);
        return Boolean(result?.id || result?.previous_response_id);
      } catch (e) {
        logger.warn('[checkVLMResponseApiSupport] failed:', e);
        return false;
      }
    }),
  checkModelAvailability: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
    }>()
    .handle(async ({ input }) => {
      const openai = new OpenAI({
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
      });
      const isThinking =
        input.modelName?.toLowerCase().includes('nemotron') ||
        input.modelName?.toLowerCase().includes('diffusiongemma') ||
        input.baseUrl?.includes('nvidia.com');

      const requestParams = {
        model: input.modelName,
        messages: [{ role: 'user' as const, content: 'return 1+1=?' }],
        stream: false as const,
        max_tokens: 1024,
        ...(isThinking
          ? { chat_template_kwargs: { enable_thinking: true } }
          : {}),
      };

      const completion = await openai.chat.completions.create(
        requestParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      );
      console.log('result', completion);

      const message = completion.choices?.[0]?.message as
        | { content?: string | null; reasoning_content?: string | null }
        | undefined;

      return Boolean(
        completion?.id || message?.content || message?.reasoning_content,
      );
    }),
});
