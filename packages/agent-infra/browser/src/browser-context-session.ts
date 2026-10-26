/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as puppeteer from 'puppeteer-core';
import { Logger, defaultLogger } from '@agent-infra/logger';
import {
  BrowserInterface,
  EvaluateOnNewPageOptions,
  LaunchOptions,
  Page,
} from './types';

/**
 * Configuration options for BrowserContextSession
 */
export interface BrowserContextSessionOptions {
  /**
   * The underlying Puppeteer Browser instance
   */
  browser: puppeteer.Browser;

  /**
   * Pre-existing BrowserContext to use. If not provided, one will be created upon initialization.
   */
  context?: puppeteer.BrowserContext;

  /**
   * Logger instance for session-specific logging
   */
  logger?: Logger;

  /**
   * Default viewport dimensions for new pages created within this session
   */
  defaultViewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
}

/**
 * BrowserContextSession implements BrowserInterface by binding to an isolated
 * Chromium BrowserContext.
 *
 * Each session owns:
 * - Isolated cookie jars, local storage, indexedDB, and cache.
 * - Context-scoped active page tracking and popup management.
 * - Independent lifecycle (closing one context does not terminate other contexts or the root browser daemon).
 */
export class BrowserContextSession implements BrowserInterface {
  protected browser: puppeteer.Browser;
  protected context: puppeteer.BrowserContext | null = null;
  protected activePage: Page | null = null;
  protected logger: Logger;
  protected defaultViewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
  protected pageListenersAttached = false;
  protected isClosed = false;

  constructor(options: BrowserContextSessionOptions) {
    this.browser = options.browser;
    this.context = options.context ?? null;
    this.logger = (options.logger ?? defaultLogger).spawn(
      '[BrowserContextSession]',
    );
    this.defaultViewport = options.defaultViewport;

    if (this.context) {
      this.setupContextListeners();
    }
  }

  /**
   * Sets up context-scoped listeners to track active page changes and popups.
   * Puppeteer's BrowserContext emits target events exclusively for targets
   * belonging to this context.
   */
  protected setupContextListeners(): void {
    if (!this.context || this.pageListenersAttached) return;

    if (typeof (this.context as any).setMaxListeners === 'function') {
      (this.context as any).setMaxListeners(50);
    }
    this.pageListenersAttached = true;

    this.context.on('targetcreated', async (target) => {
      this.logger.info('Context targetcreated:', target.type());
      if (target.type() === 'page') {
        try {
          const page = await target.page();
          if (page) {
            this.activePage = page;
            page.once('close', async () => {
              if (this.activePage === page) {
                await this.updateActivePageOnClose();
              }
            });
            page.once('error', async () => {
              if (this.activePage === page) {
                await this.updateActivePageOnClose();
              }
            });
          }
        } catch (error) {
          this.logger.error('Error handling context targetcreated:', error);
        }
      }
    });

    this.context.on('targetchanged', async (target) => {
      this.logger.info('Context targetchanged:', target.type());
      if (target.type() === 'page') {
        try {
          const changedPage = await target.page();
          if (changedPage) {
            const currentUrl = await changedPage.url();
            if (currentUrl && currentUrl !== 'about:blank') {
              this.activePage = changedPage;
            }
          }
        } catch (error) {
          this.logger.error('Error handling context targetchanged:', error);
        }
      }
    });

    this.context.on('targetdestroyed', async (target) => {
      this.logger.info('Context targetdestroyed:', target.type());
      if (target.type() === 'page') {
        await this.updateActivePageOnClose();
      }
    });
  }

  /**
   * Updates the activePage reference when a page closes, selecting the last
   * remaining responding page within this session's context.
   */
  private async updateActivePageOnClose(): Promise<void> {
    if (this.isClosed || !this.context) {
      this.activePage = null;
      return;
    }

    try {
      const pages = await this.context.pages();
      if (pages.length > 0) {
        this.activePage = pages[pages.length - 1];
      } else {
        this.activePage = null;
      }
    } catch {
      this.activePage = null;
    }
  }

  /**
   * Initializes the BrowserContext if not already initialized.
   */
  async launch(options?: LaunchOptions): Promise<void> {
    if (this.isClosed) {
      throw new Error('Cannot launch a closed BrowserContextSession');
    }

    if (!this.context) {
      this.context = await this.browser.createBrowserContext();
      if (options?.defaultViewport) {
        this.defaultViewport = options.defaultViewport;
      }
      this.setupContextListeners();
    }
  }

  /**
   * Closes this session's BrowserContext and all associated pages.
   * Does NOT terminate the parent Browser process or other sessions.
   */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.logger.info('Closing BrowserContextSession');

    if (this.context) {
      try {
        const pages = await this.context.pages();
        for (const page of pages) {
          try {
            await page.close();
          } catch {}
        }
        await this.context.close();
      } catch (error) {
        this.logger.warn('Error closing BrowserContext:', error);
      } finally {
        this.context = null;
        this.activePage = null;
      }
    }
  }

  /**
   * Checks if this session and its parent browser are active and responding.
   */
  async isBrowserAlive(): Promise<boolean> {
    if (this.isClosed || !this.context || !this.browser) {
      return false;
    }
    try {
      return this.browser.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * Returns the underlying Puppeteer Browser instance.
   */
  getBrowser(): puppeteer.Browser {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    return this.browser;
  }

  /**
   * Returns the underlying Puppeteer BrowserContext instance.
   */
  getContext(): puppeteer.BrowserContext {
    if (!this.context) {
      throw new Error('BrowserContext not initialized');
    }
    return this.context;
  }

  /**
   * Creates a new page within this isolated BrowserContext.
   */
  async createPage(): Promise<Page> {
    if (this.isClosed) {
      throw new Error('Browser session is closed');
    }
    if (!this.context) {
      await this.launch();
    }

    const page = await this.context!.newPage();
    if (this.defaultViewport) {
      await page.setViewport(this.defaultViewport);
    }
    this.activePage = page;
    return page;
  }

  /**
   * Gets the currently active page for this session.
   * If the active page is closed or no pages exist, finds the last responding
   * page in this context or creates a new one.
   */
  async getActivePage(): Promise<Page> {
    if (this.isClosed) {
      throw new Error('Browser session is closed');
    }
    if (!this.context) {
      await this.launch();
    }

    if (this.activePage) {
      try {
        await this.activePage.evaluate(() => document.readyState);
        return this.activePage;
      } catch (e) {
        this.logger.warn('Active page no longer responding:', e);
        this.activePage = null;
      }
    }

    const pages = await this.context!.pages();
    if (pages.length === 0) {
      this.activePage = await this.createPage();
      return this.activePage;
    }

    for (let i = pages.length - 1; i >= 0; i--) {
      const page = pages[i];
      try {
        await page.evaluate(() => document.readyState);
        this.activePage = page;
        return page;
      } catch {
        continue;
      }
    }

    this.activePage = await this.createPage();
    return this.activePage;
  }

  /**
   * Creates a new page within this context, navigates to the specified URL,
   * evaluates a function, and disposes the temporary page.
   */
  async evaluateOnNewPage<T extends any[], R>(
    options: EvaluateOnNewPageOptions<T, R>,
  ): Promise<R | null> {
    if (this.isClosed) {
      throw new Error('Browser session is closed');
    }
    if (!this.context) {
      await this.launch();
    }

    const {
      url,
      pageFunction,
      pageFunctionParams,
      beforePageLoad,
      afterPageLoad,
      beforeSendResult,
      waitForOptions,
    } = options;

    const page = await this.context!.newPage();
    try {
      await beforePageLoad?.(page);
      await page.goto(url, {
        waitUntil: 'networkidle2',
        ...waitForOptions,
      });
      await afterPageLoad?.(page);
      const _window = await page.evaluateHandle(() => window);
      const result = await page.evaluate(
        pageFunction,
        _window,
        ...pageFunctionParams,
      );
      await beforeSendResult?.(page, result);
      await _window.dispose();
      await page.close();
      return result;
    } catch (error) {
      await page.close();
      throw error;
    }
  }
}
