/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ActionInputs,
  PredictionParsed,
  UITarsModelVersion,
  MAX_RATIO,
  IMAGE_FACTOR,
  MIN_PIXELS,
  MAX_PIXELS_V1_5,
} from '@ui-tars/shared/types';
import isNumber from 'lodash.isnumber';

function roundByFactor(num: number, factor: number): number {
  return Math.round(num / factor) * factor;
}

function floorByFactor(num: number, factor: number): number {
  return Math.floor(num / factor) * factor;
}

function ceilByFactor(num: number, factor: number): number {
  return Math.ceil(num / factor) * factor;
}

function smartResizeForV15(
  height: number,
  width: number,
  maxRatio: number = MAX_RATIO,
  factor: number = IMAGE_FACTOR,
  minPixels: number = MIN_PIXELS,
  maxPixels: number = MAX_PIXELS_V1_5,
): [number, number] | null {
  if (Math.max(height, width) / Math.min(height, width) > maxRatio) {
    console.error(
      `absolute aspect ratio must be smaller than ${maxRatio}, got ${
        Math.max(height, width) / Math.min(height, width)
      }`,
    );
    return null;
  }

  let wBar = Math.max(factor, roundByFactor(width, factor));
  let hBar = Math.max(factor, roundByFactor(height, factor));

  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = floorByFactor(height / beta, factor);
    wBar = floorByFactor(width / beta, factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = ceilByFactor(height * beta, factor);
    wBar = ceilByFactor(width * beta, factor);
  }

  return [wBar, hBar];
}

export function actionParser(params: {
  prediction: string;
  /** [widthFactor, heightFactor] */
  factor: number | [number, number];
  screenContext?: {
    width: number;
    height: number;
  };
  scaleFactor?: number;
  mode?: 'bc' | 'o1';
  modelVer?: UITarsModelVersion;
}): {
  parsed: PredictionParsed[];
} {
  const { prediction, factor, mode, screenContext, scaleFactor, modelVer } =
    params;

  const parsed = parseActionVlm(
    prediction,
    Array.isArray(factor) ? factor : [factor, factor],
    mode,
    screenContext,
    scaleFactor,
    modelVer,
  );

  return {
    parsed,
  };
}

export function parseActionVlm(
  text: string,
  factors: [number, number] = [1000, 1000],
  mode: 'bc' | 'o1' = 'bc',
  screenContext?: {
    width: number;
    height: number;
  },
  scaleFactor?: number,
  modelVer: UITarsModelVersion = UITarsModelVersion.V1_0,
): PredictionParsed[] {
  let reflection: string | null = null;
  let thought: string | null = null;
  let actionStr = '';

  let smartResizeFactors: [number, number] | null = null;
  if (
    modelVer === UITarsModelVersion.V1_5 &&
    screenContext?.height &&
    screenContext?.width
  ) {
    smartResizeFactors = smartResizeForV15(
      screenContext.height,
      screenContext.width,
    );
  }

  text = text.trim();
  if (mode === 'bc') {
    // Parse thought/reflection based on different text patterns
    if (text.includes('Thought:')) {
      const thoughtMatch = text.match(
        /Thought: ([\s\S]+?)(?=\s*Action[:：]|$)/,
      );

      if (thoughtMatch) {
        thought = thoughtMatch[1].trim();
      }
    } else if (text.startsWith('Reflection:')) {
      const reflectionMatch = text.match(
        /Reflection: ([\s\S]+?)Action_Summary: ([\s\S]+?)(?=\s*Action[:：]|$)/,
      );
      if (reflectionMatch) {
        thought = reflectionMatch[2].trim();
        reflection = reflectionMatch[1].trim();
      }
    } else if (text.startsWith('Action_Summary:')) {
      const summaryMatch = text.match(
        /Action_Summary: (.+?)(?=\s*Action[:：]|$)/,
      );
      if (summaryMatch) {
        thought = summaryMatch[1].trim();
      }
    }

    if (!['Action:', 'Action：'].some((keyword) => text.includes(keyword))) {
      //   throw new Error('No Action found in text');
      actionStr = text;
    } else {
      const actionParts = text.split(/Action[:：]/);
      actionStr = actionParts[actionParts.length - 1];
    }
  } else if (mode === 'o1') {
    // Parse o1 format
    const thoughtMatch = text.match(/<Thought>\s*(.*?)\s*<\/Thought>/);
    const actionSummaryMatch = text.match(
      /\nAction_Summary:\s*(.*?)\s*Action:/,
    );
    const actionMatch = text.match(/\nAction:\s*(.*?)\s*<\/Output>/);

    const thoughtContent = thoughtMatch ? thoughtMatch[1] : null;
    const actionSummaryContent = actionSummaryMatch
      ? actionSummaryMatch[1]
      : null;
    const actionContent = actionMatch ? actionMatch[1] : null;

    thought = `${thoughtContent}\n<Action_Summary>\n${actionSummaryContent}`;
    actionStr = actionContent || '';
  }

  // Parse actions
  const allActions = actionStr.split('\n\n');
  const actions: PredictionParsed[] = [];

  for (const rawStr of allActions) {
    const trimmedRaw = rawStr.trim();
    if (!trimmedRaw) {
      actions.push({
        reflection: reflection,
        thought: thought || '',
        action_type: '',
        action_inputs: {},
      });
      continue;
    }

    // prettier-ignore
    const actionInstance = parseAction(rawStr.replace(/\n/g, String.raw`\n`).trimStart());
    let actionType = '';
    let actionInputs: ActionInputs = {};

    if (actionInstance) {
      actionType = actionInstance.function;
      const params = actionInstance.args;
      actionInputs = {};

      let hasInvalidCoords = false;

      for (const [paramName, param] of Object.entries(params)) {
        if (param === undefined || param === null) continue;
        const rawParam = param as string;
        const trimmedParam = rawParam.trim();

        if (paramName.includes('start_box') || paramName.includes('end_box')) {
          if (!trimmedParam) continue;
          const oriBox = trimmedParam;
          // Remove parentheses and split
          const numbers = oriBox
            .replace(/[()[\]]/g, '')
            .split(',')
            .map((s) => s.trim())
            .filter((ori) => ori !== '');

          let floatNumbers: number[] = [];
          if (numbers.length === 0) {
            floatNumbers = [];
          } else {
            const parsedNums = numbers.map(Number);
            if (parsedNums.some((n) => isNaN(n) || !Number.isFinite(n))) {
              console.error(`Invalid coordinate numbers in box '${oriBox}'`);
              hasInvalidCoords = true;
              continue;
            }

            // Convert to float and scale
            if (modelVer === UITarsModelVersion.V1_5 && smartResizeFactors) {
              floatNumbers = parsedNums.map((num, idx) => {
                const factorIndex = idx % 2;
                return num / smartResizeFactors![factorIndex];
              });
            } else {
              // Standard normalized 0-1000 coordinate system
              const allUnderOne = parsedNums.every((n) => n >= 0 && n <= 1);
              const hasOverOne = parsedNums.some((n) => n > 1);

              if (parsedNums.some((n) => n < 0 || n > 1000)) {
                console.error(
                  `Coordinates out of range [0, 1000] in box '${oriBox}'`,
                );
                hasInvalidCoords = true;
                continue;
              }

              if (allUnderOne && !hasOverOne && parsedNums.some((n) => n > 0)) {
                floatNumbers = parsedNums;
              } else {
                floatNumbers = parsedNums.map((num, idx) => {
                  const factorIndex = idx % 2;
                  return num / factors[factorIndex];
                });
              }
            }

            if (floatNumbers.length === 2) {
              floatNumbers.push(floatNumbers[0], floatNumbers[1]);
            }
          }

          actionInputs[
            paramName.trim() as keyof Omit<
              ActionInputs,
              'start_coords' | 'end_coords'
            >
          ] = JSON.stringify(floatNumbers);

          if (screenContext?.width && screenContext?.height) {
            const boxKey = paramName.includes('start_box')
              ? 'start_coords'
              : 'end_coords';
            const [x1, y1, x2 = x1, y2 = y1] = floatNumbers;
            const [widthFactor, heightFactor] = factors;

            actionInputs[boxKey] =
              floatNumbers.length >= 2 && [x1, y1, x2, y2].every(isNumber)
                ? [
                    (Math.round(
                      ((x1 + x2) / 2) * screenContext?.width * widthFactor,
                    ) /
                      widthFactor) *
                      (scaleFactor ?? 1),
                    (Math.round(
                      ((y1 + y2) / 2) * screenContext?.height * heightFactor,
                    ) /
                      heightFactor) *
                      (scaleFactor ?? 1),
                  ]
                : [];
          }
        } else if (paramName.trim() === 'content') {
          // Do NOT trim trailing whitespace/newlines from content meant to be typed
          actionInputs.content = rawParam;
        } else {
          (actionInputs as Record<string, any>)[paramName.trim()] =
            paramName.trim() === 'text' && actionType === 'type'
              ? rawParam
              : trimmedParam;
        }
      }

      // Reject coordinate-requiring actions if coordinates were explicitly invalid or missing
      const COORD_REQUIRED_ACTIONS = [
        'click',
        'left_click',
        'left_single',
        'double_click',
        'left_double',
        'triple_click',
        'left_triple',
        'middle_click',
        'right_click',
        'right_single',
      ];

      if (COORD_REQUIRED_ACTIONS.includes(actionType)) {
        if (hasInvalidCoords || Object.keys(params).length === 0) {
          console.error(
            `Rejecting action '${actionType}': missing or invalid coordinates`,
          );
          continue;
        }
      } else if (actionType === 'drag' || actionType === 'left_click_drag') {
        if (hasInvalidCoords || Object.keys(params).length === 0) {
          console.error(
            `Rejecting action '${actionType}': missing or invalid start_box/end_box coordinates`,
          );
          continue;
        }
      }

      actions.push({
        reflection: reflection,
        thought: thought || '',
        action_type: actionType,
        action_inputs: actionInputs,
      });
    } else {
      console.error(
        `Failed to parse action from instruction: '${trimmedRaw}'`,
      );
    }
  }

  if (actions.some((a) => a.action_type !== '')) {
    return actions.filter((a) => a.action_type !== '');
  }

  return actions;
}
/**
 * Parses an action string into a structured object
 * @param {string} actionStr - The action string to parse (e.g. "click(start_box='(279,81)')")
 * @returns {Object|null} Parsed action object or null if parsing fails
 */
export function parseAction(actionStr: string) {
  try {
    // Support markdown bold stripping
    actionStr = actionStr.replace(/\*\*/g, '');

    // Support format: click(start_box='<|box_start|>(x1,y1)<|box_end|>')
    // Support end_box variants: <|box_end|>, <|end_box|>
    actionStr = actionStr.replace(
      /<\|box_start\|>|<\|box_end\|>|<\|end_box\|>/g,
      '',
    );

    // Support format: click(point='<point>510 150</point>') => click(start_box='<point>510 150</point>')
    // Support format: drag(start_point='<point>458 328</point>', end_point='<point>350 309</point>') => drag(start_box='<point>458 328</point>', end_box='<point>350 309</point>')
    actionStr = actionStr
      .replace(/(?<!start_|end_)point=/g, 'start_box=')
      .replace(/start_point=/g, 'start_box=')
      .replace(/end_point=/g, 'end_box=');

    // 1. Match function name and arguments using regex: func(...)
    const functionPattern = /^(\w+)\s*\(([\s\S]*)\)$/;
    const match = actionStr.trim().match(functionPattern);

    let functionName = '';
    const kwargs: Record<string, string> = {};

    const SUPPORTED_ACTION_TYPES = new Set([
      'click',
      'left_click',
      'left_single',
      'double_click',
      'left_double',
      'triple_click',
      'left_triple',
      'middle_click',
      'right_click',
      'right_single',
      'drag',
      'left_click_drag',
      'type',
      'press',
      'release',
      'scroll',
      'hotkey',
      'wait',
      'finished',
      'finish',
      'call_user',
      'navigate',
      'navigate_back',
      'user_stop',
      'end',
    ]);

    if (match) {
      const candidateFunc = match[1].toLowerCase();
      if (!SUPPORTED_ACTION_TYPES.has(candidateFunc)) {
        throw new Error(`Unsupported action function: ${match[1]}`);
      }
      functionName = match[1];
      const argsStr = match[2];

      if (argsStr.trim()) {
        const argPairs =
          argsStr.match(/([^,']|'([^'\\]|\\.)*')+/g) || [];

        for (const pair of argPairs) {
          const eqIndex = pair.indexOf('=');
          let key: string;
          let value: string;

          if (eqIndex !== -1) {
            key = pair.slice(0, eqIndex).trim();
            value = pair
              .slice(eqIndex + 1)
              .trim()
              .replace(/^['"]|['"]$/g, '');
          } else {
            // Positional argument
            const trimmed = pair.trim();
            if (!trimmed) continue;
            value = trimmed.replace(/^['"]|['"]$/g, '');
            if (candidateFunc === 'type') {
              key = 'content';
            } else if (
              candidateFunc === 'press' ||
              candidateFunc === 'hotkey'
            ) {
              key = 'key';
            } else if (candidateFunc === 'wait' || candidateFunc === 'sleep') {
              key = 'seconds';
            } else if (candidateFunc === 'navigate') {
              key = 'url';
            } else if (candidateFunc === 'scroll') {
              key = 'direction';
            } else {
              if (!kwargs['start_box']) {
                key = 'start_box';
              } else {
                continue;
              }
            }
          }

          if (!key) continue;

          // Unescape escaped single quotes inside values (e.g. it\'s)
          value = value.replace(/\\'/g, "'");

          if (value.includes('<bbox>')) {
            value = value.replace(/<bbox>|<\/bbox>/g, '').replace(/\s+/g, ',');
            value = `(${value})`;
          }

          if (value.includes('<point>')) {
            value = value.replace(/<point>|<\/point>/g, '').replace(/\s+/g, ',');
            value = `(${value})`;
          }

          kwargs[key.trim()] = value;
        }
      }
    } else {
      // 2. External model format: e.g. "Click on the Google search box input field.\nstart_box='(500,450)'\nend_box='(500,450)'"
      const decodedStr = actionStr.replace(/\\n/g, '\n').trim();
      const VERB_TO_ACTION: Record<string, string> = {
        click: 'click',
        left_click: 'left_click',
        left_single: 'left_single',
        double_click: 'double_click',
        left_double: 'left_double',
        triple_click: 'triple_click',
        left_triple: 'left_triple',
        middle_click: 'middle_click',
        right_click: 'right_click',
        right_single: 'right_single',
        drag: 'drag',
        left_click_drag: 'drag',
        type: 'type',
        press: 'press',
        release: 'release',
        scroll: 'scroll',
        hotkey: 'hotkey',
        wait: 'wait',
        finished: 'finished',
        finish: 'finished',
        call_user: 'call_user',
        navigate: 'navigate',
        navigate_back: 'navigate_back',
        user_stop: 'user_stop',
      };

      const lines = decodedStr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        const firstLine = lines[0];
        const verbMatch = firstLine.match(/^(?:action[:：]\s*)?([a-zA-Z_]+)/i);
        if (verbMatch) {
          const rawVerb = verbMatch[1].toLowerCase();
          if (VERB_TO_ACTION[rawVerb]) {
            functionName = VERB_TO_ACTION[rawVerb];

            const argRegex =
              /\b(start_box|end_box|content|key|direction|url|text|coordinates?)\s*[:=]\s*(?:'([^']*)'|"([^"]*)"|\[([^\]]*)\]|\(([^)]*)\)|([^\s,\n\r]+))/gi;
            let argMatch: RegExpExecArray | null;

            while ((argMatch = argRegex.exec(decodedStr)) !== null) {
              let key = argMatch[1];
              if (key.toLowerCase().startsWith('coord')) {
                key = 'start_box';
              }
              let val =
                argMatch[2] ??
                argMatch[3] ??
                argMatch[4] ??
                argMatch[5] ??
                argMatch[6] ??
                '';
              val = val.trim().replace(/^['"]|['"]$/g, '');

              if (val.includes('<bbox>')) {
                val = val.replace(/<bbox>|<\/bbox>/g, '').replace(/\s+/g, ',');
              }
              if (val.includes('<point>')) {
                val = val.replace(/<point>|<\/point>/g, '').replace(/\s+/g, ',');
              }
              if (
                (key.includes('start_box') || key.includes('end_box')) &&
                !val.startsWith('(') &&
                !val.startsWith('[')
              ) {
                val = `(${val})`;
              }
              kwargs[key.trim()] = val;
            }
          }
        }
      }
    }

    if (
      kwargs['x'] !== undefined &&
      kwargs['y'] !== undefined &&
      !kwargs['start_box']
    ) {
      kwargs['start_box'] = `(${kwargs['x']},${kwargs['y']})`;
    }

    return {
      function: functionName,
      args: kwargs,
    };
  } catch (e) {
    console.error(`Failed to parse action '${actionStr}': ${e}`);
    return null;
  }
}
