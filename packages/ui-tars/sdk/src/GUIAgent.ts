/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GUIAgentData,
  UITarsModelVersion,
  StatusEnum,
  ShareVersion,
  ErrorStatusEnum,
  GUIAgentError,
  Message,
} from '@ui-tars/shared/types';
import { IMAGE_PLACEHOLDER, MAX_LOOP_COUNT } from '@ui-tars/shared/constants';
import { sleep } from '@ui-tars/shared/utils';
import asyncRetry from 'async-retry';
import { Jimp } from 'jimp';
import { v4 as uuidv4 } from 'uuid';

import { setContext, runWithContext } from './context/useContext';
import { Operator, GUIAgentConfig, InvokeParams } from './types';
import { UITarsModel } from './Model';
import { BaseGUIAgent } from './base';
import { ObservationStorage } from './observation/observationStorage';
import {
  getSummary,
  parseImageDimensions,
  processVlmParams,
  replaceBase64Prefix,
  toVlmModelFormat,
} from './utils';
import {
  INTERNAL_ACTION_SPACES_ENUM,
  MAX_SNAPSHOT_ERR_CNT,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_TEMPLATE,
} from './constants';
import OpenAI from 'openai';

export class GUIAgent<T extends Operator> extends BaseGUIAgent<
  GUIAgentConfig<T>
> {
  public readonly sessionId: string;
  public readonly maxRecentImagesWindow: number;
  private readonly operator: T;
  private readonly model: InstanceType<typeof UITarsModel>;
  private readonly logger: NonNullable<GUIAgentConfig<T>['logger']>;
  private uiTarsVersion?: UITarsModelVersion;
  private systemPrompt: string;

  private isPaused = false;
  private resumePromise: Promise<void> | null = null;
  private resolveResume: (() => void) | null = null;
  private isStopped = false;

  constructor(config: GUIAgentConfig<T>) {
    super(config);
    this.sessionId = config.sessionId || uuidv4();
    this.maxRecentImagesWindow = config.maxRecentImagesWindow ?? 5;
    this.operator = config.operator;

    ObservationStorage.getInstance().registerActiveSession(this.sessionId);

    this.model =
      config.model instanceof UITarsModel
        ? config.model
        : new UITarsModel(config.model);
    this.logger = config.logger || console;
    this.uiTarsVersion = config.uiTarsVersion;
    this.systemPrompt = config.systemPrompt || this.buildSystemPrompt();
  }

  async run(
    instruction: string,
    historyMessages?: Message[],
    remoteModelHdrs?: Record<string, string>,
  ) {
    const { operator, model, logger } = this;
    const {
      signal,
      onData,
      onError,
      retry = {},
      maxLoopCount = MAX_LOOP_COUNT,
    } = this.config;

    const currentTime = Date.now();
    const data: GUIAgentData = {
      version: ShareVersion.V1,
      systemPrompt: this.systemPrompt,
      instruction,
      modelName: this.model.modelName,
      status: StatusEnum.INIT,
      logTime: currentTime,
      conversations: [
        {
          from: 'human',
          value: instruction,
          timing: {
            start: currentTime,
            end: currentTime,
            cost: 0,
          },
        },
      ],
    };

    const executionContext = Object.assign({}, this.config, {
      logger: this.logger,
      systemPrompt: this.systemPrompt,
      factors: this.model.factors,
      model: this.model,
      signal,
    });

    // inject guiAgent config for operator to get
    setContext(executionContext);

    return runWithContext(executionContext, async () => {
      logger.info(
        `[GUIAgent] run:\nsystem prompt: ${this.systemPrompt},\nmodel version: ${this.uiTarsVersion},\nmodel config: ${JSON.stringify(this.model)}`,
      );

      let loopCnt = 0;
      let snapshotErrCnt = 0;
      let emptyResponseCnt = 0;
      let totalTokens = 0;
      let totalTime = 0;
      let previousResponseId: string | undefined;
      let lastVerification: any = null;
      let lastIntermediateState: any = null;
      let lastFinalGoalVerification: any = null;

      // start running agent
      data.status = StatusEnum.RUNNING;
      await onData?.({ data: { ...data, conversations: [] } });

      // Generate session id with UUID
      const sessionId = this.generateSessionId();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          logger.info('[GUIAgent] loopCnt:', loopCnt);
          // check pause status
          if (this.isPaused && this.resumePromise) {
            data.status = StatusEnum.PAUSE;
            await onData?.({
              data: {
                ...data,
                conversations: [],
              },
            });
            await this.resumePromise;
            data.status = StatusEnum.RUNNING;
            await onData?.({
              data: {
                ...data,
                conversations: [],
              },
            });
          }

          if (
            this.isStopped ||
            (data.status !== StatusEnum.RUNNING &&
              data.status !== StatusEnum.PAUSE) ||
            signal?.aborted
          ) {
            // check if stop or aborted
            signal?.aborted && (data.status = StatusEnum.USER_STOPPED);
            break;
          }

          if (loopCnt >= maxLoopCount) {
            Object.assign(data, {
              status: StatusEnum.ERROR,
              error: this.guiAgentErrorParser(
                ErrorStatusEnum.REACH_MAXLOOP_ERROR,
              ),
            });
            break;
          }

          if (snapshotErrCnt >= MAX_SNAPSHOT_ERR_CNT) {
            Object.assign(data, {
              status: StatusEnum.ERROR,
              error: this.guiAgentErrorParser(
                ErrorStatusEnum.SCREENSHOT_RETRY_ERROR,
              ),
            });
            break;
          }

          loopCnt += 1;
          const start = Date.now();

          const snapshot = await asyncRetry(() => operator.screenshot(), {
            retries: retry?.screenshot?.maxRetries ?? 0,
            minTimeout: 5000,
            onRetry: retry?.screenshot?.onRetry,
          });

          const imageBuffer = Buffer.from(
            replaceBase64Prefix(snapshot.base64),
            'base64',
          );
          let imageContext = parseImageDimensions(imageBuffer);
          if (!imageContext) {
            const jimpImg = await Jimp.fromBuffer(imageBuffer).catch((e) => {
              logger.error('[GUIAgent] screenshot decode error', e);
              return null;
            });
            if (jimpImg) {
              imageContext = {
                width: jimpImg.bitmap.width,
                height: jimpImg.bitmap.height,
                mime: (jimpImg as any).mime || 'image/png',
              };
            }
          }

          const width = imageContext?.width;
          const height = imageContext?.height;
          const mime = imageContext?.mime || '';

          const isValidImage = !!(snapshot?.base64 && width && height);

          if (!isValidImage) {
            loopCnt -= 1;
            snapshotErrCnt += 1;
            await sleep(1000);
            continue;
          }

          let end = Date.now();

          let screenshotPath: string | undefined;
          try {
            screenshotPath =
              await ObservationStorage.getInstance().saveScreenshot(
                this.sessionId,
                loopCnt,
                snapshot.base64,
              );
          } catch (storageErr) {
            logger.warn(
              '[GUIAgent] Failed to persist temporary screenshot:',
              storageErr,
            );
          }

          if (isValidImage) {
            data.conversations.push({
              from: 'human',
              value: IMAGE_PLACEHOLDER,
              actionOutcomeFeedback: lastVerification
                ? lastVerification.feedback
                : undefined,
              verification: lastVerification,
              intermediateStateFeedback: lastIntermediateState
                ? lastIntermediateState.feedback
                : undefined,
              intermediateState: lastIntermediateState,
              screenshotBase64: snapshot.base64,
              screenshotPath,
              screenshotContext: {
                size: {
                  width,
                  height,
                },
                mime,
                scaleFactor: snapshot.scaleFactor,
              },
              timing: {
                start,
                end,
                cost: end - start,
              },
            });
            lastVerification = null;
            lastIntermediateState = null;
            lastFinalGoalVerification = null;
            await onData?.({
              data: {
                ...data,
                conversations: data.conversations.slice(-1),
              },
            });

            // Bounded observation memory: prune uncompressed Base64 from older observations outside the recent visual window
            const imageConvs = data.conversations.filter(
              (conv) =>
                conv.value === IMAGE_PLACEHOLDER && !!conv.screenshotBase64,
            );
            if (imageConvs.length > this.maxRecentImagesWindow) {
              const excessCount =
                imageConvs.length - this.maxRecentImagesWindow;
              for (let i = 0; i < excessCount; i++) {
                delete imageConvs[i].screenshotBase64;
              }
            }
          }

          // conversations -> messages, images
          const modelFormat = toVlmModelFormat({
            historyMessages: historyMessages || [],
            conversations: data.conversations,
            systemPrompt: data.systemPrompt,
          });
          const logicalWidth =
            snapshot.scaleFactor && snapshot.scaleFactor > 1
              ? Math.round(width / snapshot.scaleFactor)
              : width;
          const logicalHeight =
            snapshot.scaleFactor && snapshot.scaleFactor > 1
              ? Math.round(height / snapshot.scaleFactor)
              : height;

          // sliding images window to vlm model
          const vlmParams: InvokeParams = {
            ...processVlmParams(modelFormat.conversations, modelFormat.images),
            screenContext: {
              width: logicalWidth,
              height: logicalHeight,
            },
            scaleFactor: snapshot.scaleFactor,
            uiTarsVersion: this.uiTarsVersion,
            headers: {
              ...remoteModelHdrs,
              'X-Session-Id': sessionId,
            },
            previousResponseId,
          };
          const {
            prediction,
            parsedPredictions,
            costTime,
            costTokens,
            responseId,
          } = await asyncRetry(
            async (bail) => {
              try {
                const result = await model.invoke(vlmParams);
                return result;
              } catch (error: unknown) {
                const err = error as any;
                const status =
                  err?.status || err?.statusCode || err?.response?.status;

                if (
                  error instanceof Error &&
                  (error?.name === 'APIUserAbortError' ||
                    error?.message?.includes('aborted'))
                ) {
                  bail(error as unknown as Error);
                  return {
                    prediction: '',
                    parsedPredictions: [],
                  };
                }

                // Do not endlessly retry permanent client errors (400, 401, 403, 404)
                if (
                  status === 400 ||
                  status === 401 ||
                  status === 403 ||
                  status === 404
                ) {
                  logger.error(
                    `[GUIAgent] Non-retriable HTTP error ${status}`,
                    error,
                  );
                  bail(error as Error);
                  return {
                    prediction: '',
                    parsedPredictions: [],
                  };
                }

                if (status === 429) {
                  logger.warn(
                    '[GUIAgent] HTTP 429 Rate limited by model provider',
                  );
                }

                Object.assign(data, {
                  status: StatusEnum.ERROR,
                  error: this.guiAgentErrorParser(
                    ErrorStatusEnum.INVOKE_RETRY_ERROR,
                    error as Error,
                  ),
                });
                throw error;
              }
            },
            {
              retries: retry?.model?.maxRetries ?? 0,
              minTimeout: 1000 * 30,
              onRetry: retry?.model?.onRetry,
            },
          );

          // Restore running status on successful invocation
          data.status = StatusEnum.RUNNING;
          data.error = undefined;

          // responseId shouldn't be assigned to null or undefined
          if (responseId) {
            previousResponseId = responseId;
          }

          totalTokens += costTokens || 0;
          totalTime += costTime || 0;

          logger.info(
            `[GUIAgent] consumes: >>> costTime: ${costTime}, costTokens: ${costTokens} <<<`,
          );
          logger.info('[GUIAgent] Response:', prediction);
          logger.info(
            '[GUIAgent] Parsed Predictions:',
            JSON.stringify(parsedPredictions),
          );

          if (!prediction || parsedPredictions.length === 0) {
            emptyResponseCnt += 1;
            logger.error(
              `[GUIAgent] Response Empty or unparseable (${emptyResponseCnt}/3):`,
              prediction,
            );
            if (emptyResponseCnt >= 3) {
              Object.assign(data, {
                status: StatusEnum.ERROR,
                error: this.guiAgentErrorParser(
                  ErrorStatusEnum.INVOKE_RETRY_ERROR,
                  new Error(
                    'Repeated empty or unparseable model responses (3 consecutive attempts)',
                  ),
                ),
              });
              break;
            }
            await sleep(2000);
            continue;
          } else {
            emptyResponseCnt = 0;
          }

          const predictionSummary = getSummary(prediction);

          end = Date.now();
          data.conversations.push({
            from: 'gpt',
            value: predictionSummary,
            timing: {
              start,
              end,
              cost: end - start,
            },
            screenshotContext: {
              size: {
                width,
                height,
              },
              scaleFactor: snapshot.scaleFactor,
            },
            predictionParsed: parsedPredictions,
          });
          await onData?.({
            data: {
              ...data,
              conversations: data.conversations.slice(-1),
            },
          });

          // start execute action
          for (const parsedPrediction of parsedPredictions) {
            const actionType = parsedPrediction.action_type;

            logger.info('[GUIAgent] Action:', actionType);

            // handle internal action spaces
            if (actionType === INTERNAL_ACTION_SPACES_ENUM.ERROR_ENV) {
              Object.assign(data, {
                status: StatusEnum.ERROR,
                error: this.guiAgentErrorParser(
                  ErrorStatusEnum.ENVIRONMENT_ERROR,
                ),
              });
              break;
            } else if (actionType === INTERNAL_ACTION_SPACES_ENUM.MAX_LOOP) {
              Object.assign(data, {
                status: StatusEnum.ERROR,
                error: this.guiAgentErrorParser(
                  ErrorStatusEnum.REACH_MAXLOOP_ERROR,
                ),
              });
              break;
            }

            if (!signal?.aborted && !this.isStopped) {
              logger.info(
                '[GUIAgent] Action Inputs:',
                parsedPrediction.action_inputs,
                parsedPrediction.action_type,
              );
              // TODO: pass executeOutput to onData
              const executeOutput = await asyncRetry(
                () =>
                  operator.execute({
                    prediction,
                    parsedPrediction,
                    screenWidth: width,
                    screenHeight: height,
                    scaleFactor: snapshot.scaleFactor,
                    factors: this.model.factors,
                  }),
                {
                  retries: retry?.execute?.maxRetries ?? 0,
                  minTimeout: 5000,
                  onRetry: retry?.execute?.onRetry,
                },
              ).catch((e) => {
                logger.error('[GUIAgent] execute error', e);
                Object.assign(data, {
                  status: StatusEnum.ERROR,
                  error: this.guiAgentErrorParser(
                    ErrorStatusEnum.EXECUTE_RETRY_ERROR,
                    e,
                  ),
                });
              });

              if (executeOutput && executeOutput?.status) {
                data.status = executeOutput.status;
              }
              if (executeOutput && (executeOutput as any).verification) {
                lastVerification = (executeOutput as any).verification;
              }
              if (executeOutput && (executeOutput as any).intermediateState) {
                lastIntermediateState = (executeOutput as any)
                  .intermediateState;
              }
              if (
                executeOutput &&
                (executeOutput as any).finalGoalVerification
              ) {
                lastFinalGoalVerification = (executeOutput as any)
                  .finalGoalVerification;
              }
              const lastGptTurn = [...data.conversations]
                .reverse()
                .find((c) => c.from === 'gpt');
              if (lastGptTurn) {
                if (lastVerification?.feedback) {
                  lastGptTurn.actionOutcomeFeedback = lastVerification.feedback;
                  lastGptTurn.verification = lastVerification;
                }
                if (lastIntermediateState?.feedback) {
                  lastGptTurn.intermediateStateFeedback =
                    lastIntermediateState.feedback;
                  lastGptTurn.intermediateState = lastIntermediateState;
                }
                if (lastFinalGoalVerification?.feedback) {
                  lastGptTurn.finalGoalFeedback =
                    lastFinalGoalVerification.feedback;
                  lastGptTurn.finalGoalVerification = lastFinalGoalVerification;
                }
              }
            }

            // Action types must break the loop after operator execution:
            if (actionType === INTERNAL_ACTION_SPACES_ENUM.CALL_USER) {
              data.status = StatusEnum.CALL_USER;
              break;
            } else if (actionType === INTERNAL_ACTION_SPACES_ENUM.FINISHED) {
              // Milestone 3: Intercept finished() when final goal is unverified
              if (
                lastFinalGoalVerification &&
                lastFinalGoalVerification.status !== 'VERIFIED'
              ) {
                logger.warn(
                  `[GUIAgent] Intercepted premature finished(): status=${lastFinalGoalVerification.status}, feedback=${lastFinalGoalVerification.feedback}`,
                );
                if (lastFinalGoalVerification.terminalEscalation) {
                  logger.error(
                    `[GUIAgent] Final goal verification terminal escalation reached: escalating to CALL_USER`,
                  );
                  data.status = StatusEnum.CALL_USER;
                  break;
                }
                // Resume running so UI-TARS receives feedback on next loop iteration
                data.status = StatusEnum.RUNNING;
                // Do NOT break; continue loop to let agent evaluate feedback and recover
              } else {
                data.status = StatusEnum.END;
                break;
              }
            }
          }

          if (
            this.config.loopIntervalInMs &&
            this.config.loopIntervalInMs > 0
          ) {
            logger.info(
              `[GUIAgent] sleep for ${this.config.loopIntervalInMs}ms before next loop`,
            );
            await sleep(this.config.loopIntervalInMs);
            logger.info(
              `[GUIAgent] sleep for ${this.config.loopIntervalInMs}ms before next loop done`,
            );
          }
        }
      } catch (error) {
        logger.error('[GUIAgent] Catch error', error);
        if (
          error instanceof Error &&
          (error.name === 'AbortError' || error.message?.includes('aborted'))
        ) {
          logger.info('[GUIAgent] Catch: request was aborted');
          data.status = StatusEnum.USER_STOPPED;
          return;
        }

        data.status = StatusEnum.ERROR;
        data.error = this.guiAgentErrorParser(
          ErrorStatusEnum.UNKNOWN_ERROR,
          error as Error,
        );

        // We only use OnError callback to dispatch error information to caller,
        // and we will not throw error to the caller.
        // throw error;
      } finally {
        logger.info('[GUIAgent] Finally: status', data.status);

        this.model?.reset();

        if (data.status === StatusEnum.USER_STOPPED) {
          await operator.execute({
            prediction: '',
            parsedPrediction: {
              action_inputs: {},
              reflection: null,
              action_type: 'user_stop',
              thought: '',
            },
            screenWidth: 0,
            screenHeight: 0,
            scaleFactor: 1,
            factors: [0, 0],
          });
        }

        await onData?.({ data: { ...data, conversations: [] } });

        if (data.status === StatusEnum.ERROR) {
          onError?.({
            data,
            error:
              data.error ||
              new GUIAgentError(
                ErrorStatusEnum.UNKNOWN_ERROR,
                'Unknown error occurred',
              ),
          });
        }

        ObservationStorage.getInstance().retainSession(this.sessionId);

        logger.info(
          `[GUIAgent] >>> totalTokens: ${totalTokens}, totalTime: ${totalTime}, loopCnt: ${loopCnt} <<<`,
        );
      }

      return data;
    });
  }

  /**
   * Explicitly disposes the temporary observation history files on disk for this session.
   * Can be called independently from agent execution teardown.
   */
  public async disposeObservationHistory(): Promise<void> {
    await ObservationStorage.getInstance().disposeSession(this.sessionId);
  }

  /**
   * Destroys runtime execution state.
   * By default, preserves observation history for the session viewer.
   * Pass { disposeHistory: true } to explicitly delete temporary screenshots on disk.
   */
  public async destroy(options?: { disposeHistory?: boolean }): Promise<void> {
    this.stop();
    if (options?.disposeHistory) {
      await this.disposeObservationHistory();
    }
  }

  public pause() {
    this.isPaused = true;
    this.resumePromise = new Promise((resolve) => {
      this.resolveResume = resolve;
    });
  }

  public resume() {
    if (this.resolveResume) {
      this.resolveResume();
      this.resumePromise = null;
      this.resolveResume = null;
    }
    this.isPaused = false;
  }

  public stop() {
    this.isStopped = true;
  }

  private buildSystemPrompt() {
    const actionSpaces = (this.operator.constructor as typeof Operator)?.MANUAL
      ?.ACTION_SPACES;

    return actionSpaces == null || actionSpaces.length === 0
      ? SYSTEM_PROMPT
      : SYSTEM_PROMPT_TEMPLATE.replace(
          '{{action_spaces_holder}}',
          actionSpaces.join('\n'),
        );
  }

  private guiAgentErrorParser(
    type: ErrorStatusEnum,
    error?: Error,
  ): GUIAgentError {
    this.logger.error('[GUIAgent] guiAgentErrorParser:', error);

    let parseError = null;

    if (
      (OpenAI?.InternalServerError &&
        error instanceof OpenAI.InternalServerError) ||
      (error as any)?.name === 'InternalServerError' ||
      (error as any)?.status === 500
    ) {
      this.logger.error(
        '[GUIAgent] guiAgentErrorParser instanceof InternalServerError.',
      );
      parseError = new GUIAgentError(
        ErrorStatusEnum.MODEL_SERVICE_ERROR,
        error?.message || 'InternalServerError',
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.REACH_MAXLOOP_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.REACH_MAXLOOP_ERROR,
        `Has reached max loop count: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.SCREENSHOT_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.SCREENSHOT_RETRY_ERROR,
        `Too many screenshot failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.INVOKE_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.INVOKE_RETRY_ERROR,
        `Too many model invoke failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.EXECUTE_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.EXECUTE_RETRY_ERROR,
        `Too many action execute failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.ENVIRONMENT_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.ENVIRONMENT_ERROR,
        `The environment error occurred when parsing the action: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.UNKNOWN_ERROR,
        error instanceof Error ? error.message : 'Unknown error occurred',
        error instanceof Error ? error.stack || 'null' : 'null',
      );
    }

    if (!parseError.stack) {
      // Avoid guiAgentErrorParser it self in stack trace
      Error.captureStackTrace(parseError, this.guiAgentErrorParser);
    }

    return parseError;
  }

  private generateSessionId(): string {
    return uuidv4();
  }
}
