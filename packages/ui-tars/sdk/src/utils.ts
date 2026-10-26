/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Jimp } from 'jimp';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { IMAGE_PLACEHOLDER, MAX_IMAGE_LENGTH } from '@ui-tars/shared/constants';
import { Conversation, Message } from '@ui-tars/shared/types';
import { DEFAULT_FACTORS, type Factors } from './constants';
import {
  ResponseInput,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
} from 'openai/resources/responses/responses.js';

/**
 * Parse box string to screen coordinates
 *
 *   e.g. '[0.131,0.25,0.131,0.25]' 2560x1440 -> { x: 335.36, y: 360 }
 *
 * @param boxStr box string
 * @param screenWidth screen width
 * @param screenHeight screen height
 * @param factors scaling factor, the training space of the target model.
 * @returns screen coordinates
 */
export const parseBoxToScreenCoords = ({
  boxStr,
  screenWidth,
  screenHeight,
  factors = DEFAULT_FACTORS,
}: {
  boxStr: string;
  screenWidth: number;
  screenHeight: number;
  factors?: Factors;
}) => {
  if (!boxStr) {
    return { x: null, y: null };
  }
  const coords = boxStr
    .replace('[', '')
    .replace(']', '')
    .split(',')
    .map((num) => parseFloat(num.trim()));

  const [x1, y1, x2 = x1, y2 = y1] = coords;
  const [widthFactor, heightFactor] = factors;

  return {
    x: Math.round(((x1 + x2) / 2) * screenWidth * widthFactor) / widthFactor,
    y: Math.round(((y1 + y2) / 2) * screenHeight * heightFactor) / heightFactor,
  };
};

export const processVlmParams = (
  conversations: Message[],
  images: string[],
  maxImageLength: number = MAX_IMAGE_LENGTH,
): {
  images: string[];
  conversations: Message[];
} => {
  // Check if the images array exceeds the limit
  // TODO: configurable max image length
  if (images.length > maxImageLength) {
    // Calculate the number of items to remove
    const excessCount = images.length - maxImageLength;

    // Remove excess images from the start
    images = images.slice(excessCount);

    // Remove corresponding conversations where "value" is "<image>"
    let imageCountToRemove = excessCount;
    conversations = conversations.filter((convo) => {
      if (imageCountToRemove > 0 && convo.value === IMAGE_PLACEHOLDER) {
        imageCountToRemove--;
        return false;
      }
      return true;
    });
  }

  // Return the processed result
  return { images, conversations };
};

export const toVlmModelFormat = ({
  historyMessages,
  conversations,
  systemPrompt,
}: {
  historyMessages: Message[];
  conversations: Conversation[];
  systemPrompt: string;
}): {
  conversations: Message[];
  images: string[];
} => {
  const USER_INSTRUCTION_MARKER = '## User Instruction';
  const history = formatHistoryMessages(historyMessages);

  // Keep all text and thought messages, but omit older IMAGE_PLACEHOLDERs that no longer retain an image in the active visual window
  const activeConversations = conversations.filter(
    (conv) => !(conv.value === IMAGE_PLACEHOLDER && !conv.screenshotBase64),
  );

  return {
    conversations: activeConversations.map((conv, idx) => {
      if (idx === 0 && conv.from === 'human') {
        let newValue = '';
        if (systemPrompt.includes(USER_INSTRUCTION_MARKER)) {
          const insertIndex = systemPrompt.lastIndexOf(USER_INSTRUCTION_MARKER);
          const slicedPrefix = systemPrompt.slice(0, insertIndex);
          const slicedSuffix = systemPrompt.slice(insertIndex);
          newValue =
            slicedPrefix +
            (slicedPrefix.endsWith('\n') ? '' : '\n') +
            history +
            '\n' +
            slicedSuffix +
            (slicedSuffix.endsWith('\n') ? '' : '\n') +
            conv.value;
        } else {
          newValue = `${systemPrompt}\n${history}\n${USER_INSTRUCTION_MARKER}\n${conv.value}`;
        }
        return {
          from: conv.from,
          value: newValue,
        };
      }
      // IMPORTANT: IMAGE_PLACEHOLDER values must NOT be modified — convertToOpenAIMessages
      // identifies image turns by strict equality (conv.value === IMAGE_PLACEHOLDER).
      // Appending feedback to an image turn would corrupt it into a text message,
      // desynchronising the images array from conversation turn indices.
      // Instead, inject the feedback into the PRECEDING assistant (gpt) turn's value
      // if it exists, or surface it as a standalone text turn if the image is the first item.
      // For image turns: preserve exact IMAGE_PLACEHOLDER value; feedback carried on screenshotContext.
      if (conv.value === IMAGE_PLACEHOLDER) {
        return {
          from: conv.from,
          value: IMAGE_PLACEHOLDER,
        };
      }
      // For all non-image turns: append outcome feedback and intermediate progress when available.
      let feedbackSuffix = '';
      if (conv.actionOutcomeFeedback) {
        feedbackSuffix += `\n[Action Outcome Verification: ${conv.actionOutcomeFeedback}]`;
      }
      if (conv.intermediateStateFeedback) {
        const formatted = conv.intermediateStateFeedback.startsWith('[')
          ? conv.intermediateStateFeedback
          : `[Intermediate Progress: ${conv.intermediateStateFeedback}]`;
        feedbackSuffix += `\n${formatted}`;
      }
      if (conv.finalGoalFeedback) {
        const formatted = conv.finalGoalFeedback.startsWith('[')
          ? conv.finalGoalFeedback
          : `[Final Goal Verification: ${conv.finalGoalFeedback}]`;
        feedbackSuffix += `\n${formatted}`;
      }
      return {
        from: conv.from,
        value: `${conv.value}${feedbackSuffix}`,
      };
    }),
    images: conversations
      .filter(
        (conv) => conv.value === IMAGE_PLACEHOLDER && !!conv.screenshotBase64,
      )
      .map((conv) => conv.screenshotBase64!),
  };
};

export const getSummary = (prediction: string) =>
  prediction
    .replace(/Reflection:[\s\S]*?(?=Action_Summary:|Action:|$)/g, '')
    .trim();

/**
 * convert conversations to OpenAI ChatCompletionMessageParam
 * @param conversations conversations
 * @param images images
 * @returns OpenAI ChatCompletionMessageParam
 */
export const convertToOpenAIMessages = ({
  conversations,
  images,
}: {
  conversations: Message[];
  images: string[];
}): Array<ChatCompletionMessageParam> => {
  const messages: Array<ChatCompletionMessageParam> = [];
  let imageIndex = 0;

  conversations.forEach((conv) => {
    if (conv.value === IMAGE_PLACEHOLDER) {
      // handle image message
      if (imageIndex < images.length) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${images[imageIndex]}` },
            },
          ],
        });
        imageIndex++;
      }
    } else {
      // handle text message
      messages.push({
        role: conv.from === 'human' ? 'user' : 'assistant',
        content: conv.value,
      });
    }
  });

  return messages;
};

/**
 * Fast, zero-allocation image header parser to extract dimensions and mime type
 * from PNG and JPEG buffers without decoding uncompressed bitmaps into memory.
 */
export function parseImageDimensions(
  buffer: Buffer,
): { width: number; height: number; mime: string } | null {
  if (!buffer || buffer.length < 24) return null;

  // PNG: signature 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height, mime: 'image/png' };
  }

  // JPEG: starts with FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height, mime: 'image/jpeg' };
      }
      // Skip variable length markers
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
      } else {
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }
  }

  return null;
}

export function replaceBase64Prefix(base64: string) {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

export async function preprocessResizeImage(
  image_base64: string,
  maxPixels: number,
): Promise<string> {
  try {
    const cleanBase64 = replaceBase64Prefix(image_base64);
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    // Fast path: inspect image headers without full pixel bitmap decoding
    const headerDims = parseImageDimensions(imageBuffer);
    if (headerDims && headerDims.width * headerDims.height <= maxPixels) {
      return cleanBase64;
    }

    const image = await Jimp.read(imageBuffer);
    const { width, height } = image.bitmap;

    const currentPixels = width * height;
    if (currentPixels > maxPixels) {
      const resizeFactor = Math.sqrt(maxPixels / currentPixels);
      const newWidth = Math.floor(width * resizeFactor);
      const newHeight = Math.floor(height * resizeFactor);

      const resized = await image
        .resize({
          w: newWidth,
          h: newHeight,
        })
        .getBuffer('image/jpeg', { quality: 75 });

      return resized.toString('base64');
    }

    return cleanBase64;
  } catch (error) {
    console.error('preprocessResizeImage error:', error);
    throw error;
  }
}

function formatHistoryMessages(messages: Message[]): string {
  const lastMessages = messages.slice(-30);

  const lines = lastMessages.map((msg) => {
    const role = msg.from === 'human' ? 'human' : 'assistant';
    return `${role}: ${msg.value}`;
  });

  // human: xxx, assistant: xxx.
  // const formattedLines = lines.map((line) => {
  //   if (line.startsWith('human:')) {
  //     return line + ',';
  //   } else {
  //     return line + '.';
  //   }
  // });

  return '## History Messages\n' + lines.join('\n') + '\n';
}

/**
 * convert ChatCompletionMessageParam to Response API input
 * @param messages messages
 * @returns Response API input
 */
export const convertToResponseApiInput = (
  messages: ChatCompletionMessageParam[],
): ResponseInput => {
  return messages.map((message) => {
    if (Array.isArray(message?.content) && message?.content.length > 0) {
      const content = message.content.map((item) => {
        if (item.type === 'image_url' && item.image_url?.url) {
          return {
            type: 'input_image',
            image_url: item.image_url.url,
          } as ResponseInputImage;
        }
        return item;
      });
      return {
        role: message.role,
        content,
      } as ResponseInputItem.Message;
    }

    return message as unknown as ResponseInputItem.Message;
  });
};

/**
 * check if the message is an image message
 * @param c message
 * @returns true if the message is an image message
 */
export const isMessageImage = (
  c: ChatCompletionMessageParam | ResponseInputItem,
) =>
  'role' in c &&
  c.role === 'user' &&
  Array.isArray(c.content) &&
  c.content.some(
    (item) =>
      (item.type === 'image_url' && item.image_url?.url) ||
      (item.type === 'input_image' && item.image_url),
  );
