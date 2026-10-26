/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import OpenAI, { type ClientOptions } from 'openai';
import {
  type ChatCompletionCreateParamsNonStreaming,
  type ChatCompletionCreateParamsBase,
  type ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { actionParser } from '@ui-tars/action-parser';

import { useContext } from './context/useContext';
import { Model, type InvokeParams, type InvokeOutput } from './types';

import {
  preprocessResizeImage,
  convertToOpenAIMessages,
  convertToResponseApiInput,
  isMessageImage,
} from './utils';
import { DEFAULT_FACTORS } from './constants';
import {
  UITarsModelVersion,
  MAX_PIXELS_V1_0,
  MAX_PIXELS_V1_5,
  MAX_PIXELS_DOUBAO,
} from '@ui-tars/shared/types';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import {
  ImagePreprocessCache,
  type ImagePreprocessCacheOptions,
  type ImagePreprocessCacheStats,
} from './cache/imagePreprocessCache';

type OpenAIChatCompletionCreateParams = Omit<ClientOptions, 'maxRetries'> &
  Pick<
    ChatCompletionCreateParamsBase,
    'model' | 'max_tokens' | 'temperature' | 'top_p'
  >;

export interface UITarsModelConfig extends OpenAIChatCompletionCreateParams {
  /** Whether to use OpenAI Response API instead of Chat Completions API */
  useResponsesApi?: boolean;
  /** Configuration for byte-aware image preprocessing cache */
  imagePreprocessCacheOptions?: ImagePreprocessCacheOptions;
}

export interface ThinkingVisionProModelConfig
  extends ChatCompletionCreateParamsNonStreaming {
  thinking?: {
    type: 'enabled' | 'disabled';
  };
}

export class UITarsModel extends Model {
  constructor(protected readonly modelConfig: UITarsModelConfig) {
    super();
    this.modelConfig = modelConfig;
    this.resizeCache = new ImagePreprocessCache(
      modelConfig.imagePreprocessCacheOptions,
    );
  }

  get useResponsesApi(): boolean {
    return this.modelConfig.useResponsesApi ?? false;
  }
  private headImageContext: {
    messageIndex: number;
    responseIds: string[];
  } | null = null;
  private resizeCache: ImagePreprocessCache;

  /** [widthFactor, heightFactor] */
  get factors(): [number, number] {
    return DEFAULT_FACTORS;
  }

  get modelName(): string {
    return this.modelConfig.model ?? 'unknown';
  }

  public getImageCacheStats(): ImagePreprocessCacheStats {
    return this.resizeCache.getStats();
  }

  public clearImageCache(): void {
    this.resizeCache.clear();
  }

  /**
   * reset the model state
   */
  reset() {
    this.headImageContext = null;
    this.resizeCache.clear();
  }

  /**
   * call real LLM / VLM Model
   * @param params
   * @param options
   * @returns
   */
  protected async invokeModelProvider(
    uiTarsVersion: UITarsModelVersion = UITarsModelVersion.V1_0,
    params: {
      messages: Array<ChatCompletionMessageParam>;
      previousResponseId?: string;
    },
    options: {
      signal?: AbortSignal;
    },
    headers?: Record<string, string>,
  ): Promise<{
    prediction: string;
    costTime?: number;
    costTokens?: number;
    responseId?: string;
  }> {
    const { logger } = useContext();
    const { messages, previousResponseId } = params;
    const {
      baseURL,
      apiKey,
      model,
      max_tokens = uiTarsVersion == UITarsModelVersion.V1_5 ? 65535 : 1000,
      temperature = 0,
      top_p = 0.7,
      ...restOptions
    } = this.modelConfig;

    const openai = new OpenAI({
      ...restOptions,
      maxRetries: 0,
      baseURL,
      apiKey,
    });

    const isNvidia = baseURL?.includes('nvidia.com');
    const isNemotron = model?.toLowerCase().includes('nemotron');
    const isDiffusionGemma = model?.toLowerCase().includes('diffusiongemma');
    const isThinkingModel = isNemotron || isDiffusionGemma || isNvidia;

    let effectiveMaxTokens = max_tokens;
    if (isNemotron) {
      effectiveMaxTokens = Math.min(max_tokens ?? 16384, 16384);
      if (effectiveMaxTokens < 4096) effectiveMaxTokens = 16384;
    } else if (isDiffusionGemma) {
      effectiveMaxTokens = Math.min(max_tokens ?? 4096, 4096);
      if (effectiveMaxTokens < 2048) effectiveMaxTokens = 4096;
    }

    const effectiveTemperature = isThinkingModel
      ? this.modelConfig.temperature !== undefined
        ? this.modelConfig.temperature
        : 1
      : temperature;
    const effectiveTopP = isThinkingModel
      ? this.modelConfig.top_p !== undefined
        ? this.modelConfig.top_p
        : 0.95
      : top_p;

    const createCompletionPrams: ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      stream: false,
      seed: isNemotron ? 42 : null,
      stop: null,
      frequency_penalty: null,
      presence_penalty: null,
      // custom options
      max_tokens: effectiveMaxTokens,
      temperature: effectiveTemperature,
      top_p: effectiveTopP,
      ...(isThinkingModel
        ? { chat_template_kwargs: { enable_thinking: true } }
        : {}),
    } as ChatCompletionCreateParamsNonStreaming;

    const createCompletionPramsThinkingVp: ThinkingVisionProModelConfig =
      isThinkingModel
        ? createCompletionPrams
        : {
            ...createCompletionPrams,
            thinking: {
              type: 'disabled',
            },
          };

    const startTime = Date.now();

    if (this.modelConfig.useResponsesApi) {
      const lastAssistantIndex = messages.findLastIndex(
        (c) => c.role === 'assistant',
      );
      logger.info('[ResponseAPI] lastAssistantIndex: ', lastAssistantIndex);
      // incremental messages
      const inputs = convertToResponseApiInput(
        lastAssistantIndex > -1
          ? messages.slice(lastAssistantIndex + 1)
          : messages,
      );

      // find the first image message
      const headImageMessageIndex = messages.findIndex(isMessageImage);
      if (
        this.headImageContext?.responseIds.length &&
        this.headImageContext?.messageIndex !== headImageMessageIndex
      ) {
        // The image window has slid. Delete the first image message.
        logger.info(
          '[ResponseAPI] should [delete]: ',
          this.headImageContext,
          'headImageMessageIndex',
          headImageMessageIndex,
        );
        const headImageResponseId = this.headImageContext.responseIds.shift();

        if (headImageResponseId) {
          const deletedResponse = await openai.responses.delete(
            headImageResponseId,
            {
              headers,
            },
          );
          logger.info(
            '[ResponseAPI] [deletedResponse]: ',
            headImageResponseId,
            deletedResponse,
          );
        }
      }

      let result;
      let responseId = previousResponseId;
      for (const input of inputs) {
        const truncated = JSON.stringify(
          [input],
          (key, value) => {
            if (typeof value === 'string' && value.startsWith('data:image/')) {
              return value.slice(0, 50) + '...[truncated]';
            }
            return value;
          },
          2,
        );
        const responseParams: ResponseCreateParamsNonStreaming = {
          input: [input],
          model,
          temperature,
          top_p,
          stream: false,
          max_output_tokens: max_tokens,
          ...(responseId && {
            previous_response_id: responseId,
          }),
          // @ts-expect-error
          thinking: {
            type: 'disabled',
          },
        };
        logger.info(
          '[ResponseAPI] [input]: ',
          truncated,
          'previous_response_id',
          responseParams?.previous_response_id,
          'headImageMessageIndex',
          headImageMessageIndex,
        );

        result = await openai.responses.create(responseParams, {
          ...options,
          timeout: 1000 * 30,
          headers,
        });
        logger.info('[ResponseAPI] [result]: ', result);
        responseId = result?.id;
        logger.info('[ResponseAPI] [responseId]: ', responseId);

        // head image changed
        if (responseId && isMessageImage(input)) {
          this.headImageContext = {
            messageIndex: headImageMessageIndex,
            responseIds: [
              ...(this.headImageContext?.responseIds || []),
              responseId,
            ],
          };
        }

        logger.info(
          '[ResponseAPI] [headImageContext]: ',
          this.headImageContext,
        );
      }

      return {
        prediction: result?.output_text ?? '',
        costTime: Date.now() - startTime,
        costTokens: result?.usage?.total_tokens ?? 0,
        responseId,
      };
    }

    // Use Chat Completions API if not using Response API
    const result = await openai.chat.completions.create(
      createCompletionPramsThinkingVp,
      {
        ...options,
        timeout: 1000 * 300,
        headers,
      },
    );

    const messageObj = result.choices?.[0]?.message as
      | { content?: string | null; reasoning_content?: string }
      | undefined;
    let prediction = messageObj?.content ?? '';
    if (messageObj?.reasoning_content) {
      if (!prediction) {
        prediction = messageObj.reasoning_content;
      } else if (
        !prediction.includes('Thought:') &&
        !prediction.includes('Thought :')
      ) {
        prediction = `Thought: ${messageObj.reasoning_content}\n${prediction}`;
      }
    }

    return {
      prediction,
      costTime: Date.now() - startTime,
      costTokens: result.usage?.total_tokens ?? 0,
    };
  }

  async invoke(params: InvokeParams): Promise<InvokeOutput> {
    const {
      conversations,
      images,
      screenContext,
      scaleFactor,
      uiTarsVersion,
      headers,
      previousResponseId,
    } = params;
    const { logger, signal } = useContext();

    logger?.info(
      `[UITarsModel] invoke: screenContext=${JSON.stringify(screenContext)}, scaleFactor=${scaleFactor}, uiTarsVersion=${uiTarsVersion}, useResponsesApi=${this.modelConfig.useResponsesApi}`,
    );

    const maxPixels =
      uiTarsVersion === UITarsModelVersion.V1_5
        ? MAX_PIXELS_V1_5
        : uiTarsVersion === UITarsModelVersion.DOUBAO_1_5_15B ||
            uiTarsVersion === UITarsModelVersion.DOUBAO_1_5_20B
          ? MAX_PIXELS_DOUBAO
          : MAX_PIXELS_V1_0;
    const compressedImages = await Promise.all(
      images.map(async (image) => {
        const cacheKey = `${maxPixels}:${image.length}:${image.slice(0, 32)}:${image.slice(-32)}`;
        const cached = this.resizeCache.get(cacheKey);
        if (cached) {
          return cached;
        }
        const resized = await preprocessResizeImage(image, maxPixels);
        this.resizeCache.set(cacheKey, resized);
        return resized;
      }),
    );

    const messages = convertToOpenAIMessages({
      conversations,
      images: compressedImages,
    });

    const startTime = Date.now();
    const result = await this.invokeModelProvider(
      uiTarsVersion,
      {
        messages,
        previousResponseId,
      },
      {
        signal,
      },
      headers,
    )
      .catch((e) => {
        logger?.error('[UITarsModel] error', e);
        throw e;
      })
      .finally(() => {
        logger?.info(`[UITarsModel cost]: ${Date.now() - startTime}ms`);
      });

    if (!result.prediction) {
      const err = new Error();
      err.name = 'vlm response error';
      err.stack = JSON.stringify(result) ?? 'no message';
      logger?.error(err);
      throw err;
    }

    const { prediction, costTime, costTokens, responseId } = result;

    try {
      const { parsed: parsedPredictions } = actionParser({
        prediction,
        factor: this.factors,
        screenContext,
        scaleFactor,
        modelVer: uiTarsVersion,
      });
      return {
        prediction,
        parsedPredictions,
        costTime,
        costTokens,
        responseId,
      };
    } catch (error) {
      logger?.error('[UITarsModel] error', error);
      return {
        prediction,
        parsedPredictions: [],
        responseId,
      };
    }
  }
}
