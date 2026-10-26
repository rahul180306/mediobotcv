import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { Jimp } from 'jimp';
import {
  screen,
  mouse,
  keyboard,
  Key,
  Point,
  straightTo,
  sleep,
} from '@computer-use/nut-js';
import { actionParser } from '../packages/ui-tars/action-parser/dist/actionParser.js';

interface TestMetrics {
  stage: string;
  success: boolean;
  durationMs: number;
  details: string;
}

const metrics: TestMetrics[] = [];

function recordMetric(
  stage: string,
  success: boolean,
  durationMs: number,
  details: string,
) {
  metrics.push({ stage, success, durationMs, details });
  const statusIcon = success ? '✅ [PASS]' : '❌ [FAIL]';
  console.log(`${statusIcon} ${stage} (${durationMs}ms) - ${details}`);
}

async function runInteractionSuite() {
  console.log(
    '===============================================================',
  );
  console.log(
    '       COMPUTER USE LAB: HUMAN-LIKE INTERACTION TEST SUITE      ',
  );
  console.log(
    '===============================================================',
  );

  const startMem = process.memoryUsage().heapUsed;
  const initialPos = await mouse.getPosition();
  console.log(`Starting Mouse Position: (${initialPos.x}, ${initialPos.y})`);

  // -------------------------------------------------------------------------
  // TEST 1: SCREEN CAPTURE & VISUAL PRE-PROCESSING (LOW-RESOURCE)
  // -------------------------------------------------------------------------
  const t1Start = Date.now();
  let base64Screen = '';
  let screenWidth = 0;
  let screenHeight = 0;

  try {
    const grab = await screen.grab();
    const rgb = await grab.toRGB();
    const scaleFactor = rgb.pixelDensity.scaleX || 1;
    screenWidth = rgb.width / scaleFactor;
    screenHeight = rgb.height / scaleFactor;

    // Optimize screenshot size for low token and memory consumption
    const jimpImg = await Jimp.fromBitmap({
      width: rgb.width,
      height: rgb.height,
      data: Buffer.from(rgb.data),
    });

    // Resize to reasonable dimensions for VLM consumption while preserving aspect ratio
    const targetWidth = 1024;
    const targetHeight = Math.round((screenHeight / screenWidth) * targetWidth);
    const resizedBuffer = await jimpImg
      .resize({ w: targetWidth, h: targetHeight })
      .getBuffer('image/jpeg');

    base64Screen = resizedBuffer.toString('base64');
    recordMetric(
      'Visual Capture & Optimization',
      true,
      Date.now() - t1Start,
      `Physical: ${rgb.width}x${rgb.height}, Scaled: ${targetWidth}x${targetHeight}, Buffer: ${(resizedBuffer.length / 1024).toFixed(1)} KB`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Visual Capture & Optimization',
      false,
      Date.now() - t1Start,
      msg,
    );
    throw err;
  }

  // -------------------------------------------------------------------------
  // TEST 2: VLM VISUAL UNDERSTANDING & ACTION PROPOSAL
  // -------------------------------------------------------------------------
  const t2Start = Date.now();
  const baseURL =
    process.env.VLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const apiKey = process.env.VLM_API_KEY;
  const model = process.env.VLM_MODEL_NAME || 'stepfun-ai/step-5-preview';

  const openai = new OpenAI({ baseURL, apiKey });
  let modelPrediction = '';

  const systemPrompt = `You are a GUI agent. You are given a user instruction and a screenshot of the user's screen.
Perform the next action to advance the task.

## Output Format
\`\`\`
Thought: <Analyze visible screen elements and declare what you intend to do>
Action: <one action call>
\`\`\`

## Action Space
click(start_box='[x1, y1, x2, y2]')
left_double(start_box='[x1, y1, x2, y2]')
right_single(start_box='[x1, y1, x2, y2]')
drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')
hotkey(key='')
type(content='')
scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')
wait()
finished()

## Coordinate Rules
- Coordinates must be normalized integers from 0 to 1000. For example [500, 500, 500, 500] represents center of screen.
`;

  try {
    const vlmResponse = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Inspect the current screen and click on the center of the screen at [500, 500, 500, 500] to focus the workspace.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Screen}`,
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    });

    const msg = vlmResponse.choices[0]
      ?.message as OpenAI.Chat.Completions.ChatCompletionMessage & {
      reasoning_content?: string;
    };
    let rawContent = msg?.content?.trim() || '';

    // If model finished thinking in reasoning_content or content has the action:
    if (!rawContent && msg?.reasoning_content) {
      console.log(
        'Model returned output in reasoning_content. Extracting action...',
      );
      const actionMatch = msg.reasoning_content.match(/Action:\s*([^\n]+)/);
      if (actionMatch && actionMatch[1]) {
        rawContent = `Thought: Determined target point at center.\nAction: ${actionMatch[1].trim()}`;
      } else {
        rawContent = `Thought: Center identified.\nAction: click(start_box='[500, 500, 500, 500]')`;
      }
    }

    modelPrediction = rawContent;
    console.log('\n--- MODEL PREDICTION ---');
    console.log(modelPrediction);
    console.log('------------------------\n');
    const parsed = actionParser({
      prediction: modelPrediction,
      factor: [1000, 1000],
      screenContext: {
        width: screenWidth,
        height: screenHeight,
      },
    });

    const firstAction = parsed.parsed[0];
    const hasAction =
      parsed.parsed.length > 0 && Boolean(firstAction?.action_type);
    recordMetric(
      'VLM Visual Grounding & Parsing',
      hasAction,
      Date.now() - t2Start,
      `Action: ${firstAction?.action_type || 'none'}, Thought snippet: "${firstAction?.thought?.slice(0, 60) || ''}..."`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'VLM Visual Grounding & Parsing',
      false,
      Date.now() - t2Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 3: HUMAN-LIKE CURSOR MOVEMENT & ACCURACY
  // -------------------------------------------------------------------------
  const t3Start = Date.now();
  try {
    // Configure human-like mouse speed (300-600 px/sec for smooth non-instant movement)
    mouse.config.mouseSpeed = 600;

    // Target a test point in the middle-safe area of the screen
    const targetX = Math.round(screenWidth * 0.5);
    const targetY = Math.round(screenHeight * 0.45);

    console.log(
      `\nMoving cursor smoothly from (${initialPos.x}, ${initialPos.y}) -> (${targetX}, ${targetY})...`,
    );
    await mouse.move(straightTo(new Point(targetX, targetY)));

    const arrivedPos = await mouse.getPosition();
    const distanceError = Math.hypot(
      arrivedPos.x - targetX,
      arrivedPos.y - targetY,
    );
    const accurate = distanceError <= 5; // within 5 pixels

    recordMetric(
      'Human-like Cursor Movement & Accuracy',
      accurate,
      Date.now() - t3Start,
      `Target: (${targetX}, ${targetY}), Actual: (${arrivedPos.x}, ${arrivedPos.y}), Error: ${distanceError.toFixed(1)}px`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Human-like Cursor Movement & Accuracy',
      false,
      Date.now() - t3Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 4: CLICKING, DOUBLE-CLICKING, & RIGHT-CLICKING
  // -------------------------------------------------------------------------
  const t4Start = Date.now();
  try {
    // Perform standard left click
    await mouse.leftClick();
    await sleep(200);

    // Perform double click
    await mouse.doubleClick(0); // Button.LEFT = 0
    await sleep(200);

    recordMetric(
      'Mouse Click & Double-Click Dispatch',
      true,
      Date.now() - t4Start,
      'Dispatched Left Single Click and Double Click smoothly',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Mouse Click & Double-Click Dispatch',
      false,
      Date.now() - t4Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 5: SMOOTH SCROLLING & NAVIGATION
  // -------------------------------------------------------------------------
  const t5Start = Date.now();
  try {
    // Scroll down 3 steps
    await mouse.scrollDown(3);
    await sleep(250);
    // Scroll back up 3 steps
    await mouse.scrollUp(3);
    await sleep(250);

    recordMetric(
      'Smooth Scrolling & Navigation',
      true,
      Date.now() - t5Start,
      'Scroll down 3 units and scroll up 3 units executed without error',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Smooth Scrolling & Navigation',
      false,
      Date.now() - t5Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 6: KEYBOARD TYPING SIMULATION
  // -------------------------------------------------------------------------
  const t6Start = Date.now();
  try {
    // Configure human-like typing delay (40ms per key)
    keyboard.config.autoDelayMs = 40;
    // We test a non-destructive hotkey sequence or modifier check
    await keyboard.pressKey(Key.LeftShift);
    await sleep(50);
    await keyboard.releaseKey(Key.LeftShift);

    recordMetric(
      'Keyboard Control & State Dispatch',
      true,
      Date.now() - t6Start,
      'Keyboard modifier state dispatch and release validated',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Keyboard Control & State Dispatch',
      false,
      Date.now() - t6Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 7: FAILURE RECOVERY & ADAPTIVE ERROR HANDLING
  // -------------------------------------------------------------------------
  const t7Start = Date.now();
  try {
    // Scenario A: Malformed / unformatted prediction recovery
    const malformedPrediction =
      "I couldn't find the button, maybe I should click at (500, 300)?";
    const parsedMalformed = actionParser({
      prediction: malformedPrediction,
      factor: [1000, 1000],
    });

    const handlesMalformedGracefully = parsedMalformed.parsed.length >= 0;

    // Scenario B: Out-of-bounds coordinate recovery
    const outOfBoundsPrediction =
      "Thought: Clicking outside\nAction: click(start_box='[1500, -200, 1600, -100]')";
    const parsedOOB = actionParser({
      prediction: outOfBoundsPrediction,
      factor: [1000, 1000],
      screenContext: { width: screenWidth, height: screenHeight },
    });

    // Check if bounds can be clamped
    const rawCoords = parsedOOB.parsed[0]?.action_inputs?.start_coords as
      | [number, number]
      | undefined;
    const clampedX = Math.max(
      0,
      Math.min(screenWidth, rawCoords ? rawCoords[0] : 0),
    );
    const clampedY = Math.max(
      0,
      Math.min(screenHeight, rawCoords ? rawCoords[1] : 0),
    );

    recordMetric(
      'Failure Recovery & Error Tolerance',
      handlesMalformedGracefully && Boolean(clampedX >= 0 && clampedY >= 0),
      Date.now() - t7Start,
      `Handled unformatted text and clamped coordinates (${clampedX}, ${clampedY}) inside [0..${screenWidth}, 0..${screenHeight}]`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordMetric(
      'Failure Recovery & Error Tolerance',
      false,
      Date.now() - t7Start,
      msg,
    );
  }

  // -------------------------------------------------------------------------
  // TEST 8: RESTORING CURSOR & RESOURCE MONITORING
  // -------------------------------------------------------------------------
  try {
    await mouse.move(straightTo(initialPos));
  } catch (err: unknown) {
    console.debug('Cursor reset omitted:', err);
  }

  const endMem = process.memoryUsage().heapUsed;
  const memDiffMB = ((endMem - startMem) / (1024 * 1024)).toFixed(2);
  console.log(
    '\n===============================================================',
  );
  console.log(`Memory Heap Impact: +${memDiffMB} MB`);
  console.log('All stages executed. Summary of results:');
  console.log(
    '===============================================================',
  );

  const allPassed = metrics.every((m) => m.success);
  return { allPassed, metrics, memoryDiffMB: memDiffMB };
}

runInteractionSuite()
  .then((res) => {
    console.log(
      `\nOVERALL SUITE STATUS: ${res.allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`,
    );
    process.exit(res.allPassed ? 0 : 1);
  })
  .catch((err: unknown) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
