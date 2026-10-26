import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { actionParser } from '../packages/ui-tars/action-parser/dist/actionParser.js';
import { SYSTEM_PROMPT } from '../packages/ui-tars/sdk/dist/constants.js';

async function testVLM() {
  console.log('--- Testing Vision AI Model Compatibility ---');
  const baseURL =
    process.env.VLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const apiKey = process.env.VLM_API_KEY;
  const model = process.env.VLM_MODEL_NAME || 'stepfun-ai/step-5-preview';

  console.log(`Endpoint: ${baseURL}`);
  console.log(`Model: ${model}`);
  console.log(
    `API Key set: ${Boolean(apiKey)} (Length: ${apiKey?.length || 0})`,
  );

  if (!apiKey) {
    throw new Error('VLM_API_KEY is not defined in .env');
  }

  const openai = new OpenAI({
    baseURL,
    apiKey,
  });

  // 1x1 transparent/white PNG base64
  const sampleBase64Png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  console.log('\nSending test prompt with image to model...');
  const startTime = Date.now();

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Find and click the center of the screen to open the app.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${sampleBase64Png}`,
              },
            },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.2,
      top_p: 0.7,
    });

    const elapsed = Date.now() - startTime;
    const content = response.choices[0]?.message?.content || '';
    console.log(`\nResponse received in ${elapsed}ms:`);
    console.log('--------------------------------------------------');
    console.log(content);
    console.log('--------------------------------------------------');

    console.log('\nParsing response with UI-TARS Action Parser...');
    const parsed = actionParser({
      prediction: content,
      factor: [1000, 1000],
      screenContext: {
        width: 1920,
        height: 1080,
      },
    });

    console.log('Action Parser Result:', JSON.stringify(parsed, null, 2));

    if (parsed.parsed.length > 0) {
      console.log(
        'SUCCESS: Model output successfully parsed into UI-TARS action space!',
      );
      return { success: true, parsed };
    } else {
      console.warn(
        'WARNING: Model replied, but action parser did not detect valid UI-TARS action syntax.',
      );
      return { success: false, content };
    }
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error('ERROR during VLM completion test:', errMessage);
    return { success: false, error };
  }
}

testVLM().then((res) => {
  console.log(
    '\nCompatibility Test Summary:',
    res.success ? 'PASSED' : 'ACTION NEEDED',
  );
  process.exit(res.success ? 0 : 1);
});
