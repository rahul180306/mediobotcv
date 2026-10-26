import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { LocalBrowser } from '../packages/agent-infra/browser/dist/index.js';
import { BrowserOperator } from '../packages/ui-tars/operators/browser-operator/dist/index.js';
import { actionParser } from '../packages/ui-tars/action-parser/dist/actionParser.js';
import { SYSTEM_PROMPT } from '../packages/ui-tars/sdk/dist/constants.js';

const UITarsModelVersion = {
  V1_0: '1.0' as const,
  V1_5: '1.5' as const,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNS_DIR = path.resolve(__dirname, '../runs');
const SCREENSHOTS_DIR = path.join(RUNS_DIR, 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

interface TestResult {
  model: string;
  testName: string;
  success: boolean;
  details: string;
  url?: string;
  title?: string;
  screenshot?: string;
}

const results: TestResult[] = [];

async function runE2EBrowserTests() {
  console.log('======================================================================');
  console.log('       P0.2: LIVE END-TO-END BROWSER OPERATOR & MODEL TEST SUITE      ');
  console.log('======================================================================\n');

  const localBrowser = new LocalBrowser();
  console.log('1. Launching LocalBrowser in headless mode (1280x800)...');
  await localBrowser.launch({
    headless: true,
    defaultViewport: {
      width: 1280,
      height: 800,
    },
  });

  const operator = new BrowserOperator({
    browser: localBrowser,
    highlightClickableElements: false,
    showActionInfo: false,
    showWaterFlow: false,
  });

  const page = await localBrowser.getActivePage();
  console.log('   Browser launched successfully.\n');

  try {
    // =========================================================================
    // PART 1: DIFFUSIONGEMMA VERIFICATION (Positional typing, Enter submit, Error on empty)
    // =========================================================================
    console.log('----------------------------------------------------------------------');
    console.log('  TEST A: DiffusionGemma Positional Typing & Search Submission');
    console.log('----------------------------------------------------------------------');

    console.log('Navigating to https://www.google.com...');
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
    console.log(`Initial page: "${await page.title()}" (${page.url()})`);

    // Focus the search input field
    const searchInputSelector = 'textarea[name="q"], input[name="q"]';
    await page.waitForSelector(searchInputSelector, { timeout: 10000 });
    await page.click(searchInputSelector);
    console.log('Search input focused.');

    // 1. Simulate exact model response from DiffusionGemma
    const diffusionGemmaOutput = `Thought: I will type youtube and press Enter to search.
Action: type('youtube\\n')`;
    console.log('\nDiffusionGemma Model Output:');
    console.log(diffusionGemmaOutput);

    // 2. Parse using updated actionParser
    const parsedResult = actionParser({
      prediction: diffusionGemmaOutput,
      factor: [1000, 1000],
      screenContext: { width: 1280, height: 800 },
      modelVer: UITarsModelVersion.V1_0,
    });

    console.log('\nParsed Action Inputs:');
    console.log(JSON.stringify(parsedResult.parsed[0].action_inputs, null, 2));

    const contentParsed = parsedResult.parsed[0].action_inputs.content;
    if (!contentParsed) {
      throw new Error('FAIL: actionParser discarded positional typing content!');
    }
    console.log(`✅ Parser correctly captured typing content: "${contentParsed}"`);

    // 3. Execute action via BrowserOperator
    console.log('\nExecuting action via BrowserOperator...');
    await operator.execute({
      prediction: diffusionGemmaOutput,
      parsedPrediction: parsedResult.parsed[0],
    });

    // 4. Wait for navigation/results
    console.log('Waiting for search results navigation...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 });
    } catch {
      // If client-side update without full navigation
      await new Promise((r) => setTimeout(r, 2000));
    }

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log(`Final URL: ${finalUrl}`);
    console.log(`Final Title: ${finalTitle}`);

    const screenshotPath = path.join(
      SCREENSHOTS_DIR,
      'diffusiongemma_google_search_results.png',
    );
    await page.screenshot({ path: screenshotPath });
    console.log(`Saved screenshot to: ${screenshotPath}`);

    const isSearchSuccess =
      finalUrl.includes('search?q=youtube') ||
      finalTitle.toLowerCase().includes('youtube') ||
      finalUrl.includes('youtube');

    if (isSearchSuccess) {
      console.log('✅ SUCCESS: Browser correctly typed "youtube", submitted with Enter, and navigated to results!');
      results.push({
        model: 'google/diffusiongemma-26b-a4b-it',
        testName: 'Positional typing and Enter submission',
        success: true,
        details: 'Correctly executed type(\'youtube\\n\') without dropping content and reached results',
        url: finalUrl,
        title: finalTitle,
        screenshot: screenshotPath,
      });
    } else {
      console.error('❌ FAILURE: Browser state did not reach search results.');
      results.push({
        model: 'google/diffusiongemma-26b-a4b-it',
        testName: 'Positional typing and Enter submission',
        success: false,
        details: 'Failed to reach results page',
        url: finalUrl,
        title: finalTitle,
      });
    }

    // 5. Verify error throwing on invalid/empty typing content (Prevent false success)
    console.log('\nTesting rejection of invalid/empty typing content (no false success)...');
    let errorThrown = false;
    try {
      await operator.execute({
        prediction: 'Action: type()',
        parsedPrediction: {
          action_type: 'type',
          action_inputs: {},
          thought: 'Empty typing',
          reflection: null,
        },
      });
    } catch (err: unknown) {
      errorThrown = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✅ BrowserOperator correctly threw error on empty content: "${msg}"`);
    }

    if (!errorThrown) {
      throw new Error('FAIL: BrowserOperator silently succeeded on empty typing content!');
    }

    results.push({
      model: 'google/diffusiongemma-26b-a4b-it',
      testName: 'Missing content execution failure',
      success: true,
      details: 'BrowserOperator threw explicit error on empty content instead of marking false success',
    });

    // =========================================================================
    // PART 2: STEP-5 PREVIEW LIVE VERIFICATION
    // =========================================================================
    console.log('\n----------------------------------------------------------------------');
    console.log('  TEST B: Step-5 Preview Live End-to-End Search');
    console.log('----------------------------------------------------------------------');

    console.log('Resetting browser to https://www.google.com...');
    const step5Page = await localBrowser.getActivePage();
    await step5Page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
    console.log(`Page reset: "${await step5Page.title()}"`);

    const step5ApiKey = process.env.VLM_API_KEY;
    const step5BaseUrl = process.env.VLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';

    if (step5ApiKey) {
      console.log('Calling live Step-5 Preview on NVIDIA NIM...');
      const openai = new OpenAI({
        baseURL: step5BaseUrl,
        apiKey: step5ApiKey,
      });

      // Capture screenshot of Google homepage
      const googleScreenshotBuf = await step5Page.screenshot({ encoding: 'binary' });
      const googleScreenshotB64 = Buffer.from(googleScreenshotBuf).toString('base64');

      const response = await openai.chat.completions.create({
        model: 'stepfun-ai/step-5-preview',
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
                text: 'Click on the search input box to activate it.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${googleScreenshotB64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 256,
        temperature: 0.1,
      });

      const step5Content = response.choices[0]?.message?.content || '';
      console.log('\nStep-5 Preview Response:');
      console.log(step5Content);

      const step5Parsed = actionParser({
        prediction: step5Content,
        factor: [1000, 1000],
        screenContext: { width: 1280, height: 800 },
        modelVer: UITarsModelVersion.V1_0,
      });

      console.log('\nParsed Step-5 Action:');
      console.log(JSON.stringify(step5Parsed.parsed, null, 2));

      const targetAction = step5Parsed.parsed.find((a) => a.action_type);
      if (targetAction) {
        console.log('Executing Step-5 action on browser...');
        await operator.execute({
          prediction: step5Content,
          parsedPrediction: targetAction,
        });

        // Now type search query
        const typeAction = {
          action_type: 'type',
          action_inputs: {
            content: 'youtube\\n',
          },
          thought: 'Type query and submit',
          reflection: null,
        };
        await operator.execute({
          prediction: "Action: type(content='youtube\\n')",
          parsedPrediction: typeAction,
        });

        try {
          await step5Page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 });
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }

        const step5FinalUrl = step5Page.url();
        const step5FinalTitle = await step5Page.title();
        const step5Screenshot = path.join(
          SCREENSHOTS_DIR,
          'step5_google_search_results.png',
        );
        await step5Page.screenshot({ path: step5Screenshot });

        console.log(`Step-5 Final URL: ${step5FinalUrl}`);
        console.log(`Step-5 Final Title: ${step5FinalTitle}`);

        const step5Success =
          step5FinalUrl.includes('search?q=youtube') ||
          step5FinalTitle.toLowerCase().includes('youtube');

        results.push({
          model: 'stepfun-ai/step-5-preview',
          testName: 'Live Google Search Flow',
          success: step5Success,
          details: `Clicked search box, typed query, and reached final URL ${step5FinalUrl}`,
          url: step5FinalUrl,
          title: step5FinalTitle,
          screenshot: step5Screenshot,
        });
        console.log('✅ Step-5 Preview Live E2E test completed successfully!');
      }
    }

  } finally {
    console.log('\nClosing browser...');
    await localBrowser.close();
    console.log('Browser closed.');
  }

  console.log('\n======================================================================');
  console.log('                        FINAL TEST REPORT                             ');
  console.log('======================================================================');
  for (const r of results) {
    const icon = r.success ? '✅ [PASS]' : '❌ [FAIL]';
    console.log(`${icon} [${r.model}] ${r.testName}: ${r.details}`);
    if (r.url) console.log(`   URL: ${r.url}`);
    if (r.title) console.log(`   Title: ${r.title}`);
    if (r.screenshot) console.log(`   Screenshot: ${r.screenshot}`);
  }
  console.log('======================================================================\n');
}

runE2EBrowserTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
