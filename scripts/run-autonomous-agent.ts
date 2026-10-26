import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUIAgent,
  UITarsModelVersion,
} from '../packages/ui-tars/sdk/dist/index.js';
import { NutJSOperator } from '../packages/ui-tars/operators/nut-js/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNS_DIR = path.resolve(__dirname, '../runs');
const SCREENSHOTS_DIR = path.join(RUNS_DIR, 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

interface StepLog {
  step: number;
  timestamp: string;
  thought: string;
  actions: unknown[];
  screenshotPath?: string;
  costTimeMs?: number;
  costTokens?: number;
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
  status: string;
}

interface RunTelemetry {
  instruction: string;
  model: string;
  provider: string;
  startTime: string;
  endTime?: string;
  totalDurationMs?: number;
  finalStatus?: string;
  steps: StepLog[];
  failures: Record<string, unknown>[];
  recoveryAttempts: Record<string, unknown>[];
}

const telemetry: RunTelemetry = {
  instruction:
    'Open YouTube, search for Leo Badass song, and play the correct video.',
  model: process.env.VLM_MODEL_NAME || 'stepfun-ai/step-5-preview',
  provider: process.env.VLM_PROVIDER || 'Hugging Face for UI-TARS-1.5',
  startTime: new Date().toISOString(),
  steps: [],
  failures: [],
  recoveryAttempts: [],
};

function saveTelemetry() {
  const telemetryPath = path.join(RUNS_DIR, 'latest_run_telemetry.json');
  fs.writeFileSync(telemetryPath, JSON.stringify(telemetry, null, 2), 'utf-8');
}

async function runAutonomousAgent() {
  console.log(
    '======================================================================',
  );
  console.log(
    '       AUTONOMOUS COMPUTER-USE LAB: LIVE END-TO-END AGENT RUN         ',
  );
  console.log(
    '======================================================================',
  );
  console.log(`Task: "${telemetry.instruction}"`);
  console.log(`Model: ${telemetry.model}`);
  console.log(`Endpoint: ${process.env.VLM_BASE_URL}`);
  console.log(
    `Initial RSS: ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(2)} MB`,
  );
  console.log(
    '======================================================================\n',
  );

  let stepCounter = 0;
  const operator = new NutJSOperator();

  const guiAgent = new GUIAgent({
    model: {
      baseURL: process.env.VLM_BASE_URL,
      apiKey: process.env.VLM_API_KEY,
      model: process.env.VLM_MODEL_NAME || 'stepfun-ai/step-5-preview',
      max_tokens: 4096,
      temperature: 0.2,
      top_p: 0.7,
    },
    operator,
    uiTarsVersion: UITarsModelVersion.V1_5,
    maxLoopCount: 20,
    loopIntervalInMs: 2500,
    retry: {
      model: {
        maxRetries: 3,
        onRetry: (err, attempt) => {
          console.warn(
            `[RECOVERY] Model invoke retry attempt ${attempt}: ${err.message}`,
          );
          telemetry.recoveryAttempts.push({
            type: 'model_retry',
            attempt,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          saveTelemetry();
        },
      },
      screenshot: {
        maxRetries: 3,
        onRetry: (err, attempt) => {
          console.warn(
            `[RECOVERY] Screenshot capture retry attempt ${attempt}: ${err.message}`,
          );
          telemetry.recoveryAttempts.push({
            type: 'screenshot_retry',
            attempt,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          saveTelemetry();
        },
      },
      execute: {
        maxRetries: 2,
        onRetry: (err, attempt) => {
          console.warn(
            `[RECOVERY] Action execution retry attempt ${attempt}: ${err.message}`,
          );
          telemetry.recoveryAttempts.push({
            type: 'execute_retry',
            attempt,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          saveTelemetry();
        },
      },
    },
    onData: async ({ data }) => {
      const lastConv = data.conversations[data.conversations.length - 1];
      if (!lastConv) return;

      const mem = process.memoryUsage();
      const memStats = {
        heapUsedMB: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
        heapTotalMB: Math.round((mem.heapTotal / (1024 * 1024)) * 100) / 100,
        rssMB: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
      };

      // Case 1: Snapshot captured from human/OS side
      if (lastConv.screenshotBase64) {
        stepCounter += 1;
        const filename = `step_${stepCounter}_${Date.now()}.png`;
        const filepath = path.join(SCREENSHOTS_DIR, filename);
        const cleanBase64 = lastConv.screenshotBase64.replace(
          /^data:image\/\w+;base64,/,
          '',
        );
        fs.writeFileSync(filepath, Buffer.from(cleanBase64, 'base64'));

        console.log(
          `\n📸 [STEP ${stepCounter}] New Screen Observation Captured -> ${filename}`,
        );
        console.log(
          `   Dimensions: ${lastConv.screenshotContext?.size?.width}x${lastConv.screenshotContext?.size?.height} (scale: ${lastConv.screenshotContext?.scaleFactor})`,
        );
        console.log(
          `   App RSS: ${memStats.rssMB} MB, Heap: ${memStats.heapUsedMB} MB`,
        );

        telemetry.steps.push({
          step: stepCounter,
          timestamp: new Date().toISOString(),
          thought: 'Observing screen...',
          actions: [],
          screenshotPath: filepath,
          memory: memStats,
          status: data.status,
        });
        saveTelemetry();
      }

      // Case 2: AI response from gpt/model side
      if (lastConv.predictionParsed && lastConv.predictionParsed.length > 0) {
        const parsed = lastConv.predictionParsed[0];
        if (parsed) {
          const thought =
            parsed.thought || lastConv.value || 'No thought recorded';
          const currentStepLog = telemetry.steps[telemetry.steps.length - 1];

          if (currentStepLog) {
            currentStepLog.thought = thought;
            currentStepLog.actions = lastConv.predictionParsed;
            currentStepLog.costTimeMs = lastConv.timing?.cost;
            currentStepLog.status = data.status;
          }

          console.log(`\n🤖 [AI DECISION - STEP ${stepCounter}]:`);
          console.log(`   💭 Thought: ${thought}`);
          console.log(
            `   ⚡ Action: ${parsed.action_type}(${JSON.stringify(parsed.action_inputs)})`,
          );
          console.log(
            `   ⏱️  Decision Latency: ${lastConv.timing?.cost || 0} ms`,
          );
          saveTelemetry();
        }
      }
    },
    onError: ({ error }) => {
      console.error(`\n❌ [AGENT LOOP ERROR]:`, error);
      telemetry.failures.push({
        status: error.status,
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });
      saveTelemetry();
    },
  });

  const runStartTime = Date.now();

  try {
    console.log(`Initiating autonomous execution loop...`);
    await guiAgent.run(telemetry.instruction);
    telemetry.finalStatus = 'COMPLETED';
    console.log(`\n🎉 Agent execution completed normally.`);
  } catch (err: unknown) {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    console.error(
      `\n⚠️ Agent loop terminated with exception:`,
      errorObj.message,
    );
    telemetry.finalStatus = 'TERMINATED_WITH_ERROR';
    telemetry.failures.push({
      fatal: true,
      error: errorObj.message,
      stack: errorObj.stack,
      timestamp: new Date().toISOString(),
    });
  } finally {
    telemetry.endTime = new Date().toISOString();
    telemetry.totalDurationMs = Date.now() - runStartTime;
    saveTelemetry();
    console.log(
      `\nRun finished in ${(telemetry.totalDurationMs / 1000).toFixed(1)}s.`,
    );
    console.log(
      `Telemetry recorded at: ${path.join(RUNS_DIR, 'latest_run_telemetry.json')}`,
    );
  }
}

runAutonomousAgent()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('Fatal crash:', err);
    process.exit(1);
  });
