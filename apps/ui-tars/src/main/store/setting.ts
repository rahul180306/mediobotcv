/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import ElectronStore from 'electron-store';
import yaml from 'js-yaml';

import * as env from '@main/env';
import { logger } from '@main/logger';

import {
  LocalStore,
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
} from './types';
import { validatePreset } from './validate';
import { BrowserWindow } from 'electron';

export const DEFAULT_SETTING: LocalStore = {
  language: 'en',
  vlmProvider: (env.vlmProvider as VLMProviderV2) || '',
  vlmBaseUrl: env.vlmBaseUrl || '',
  vlmApiKey: env.vlmApiKey || '',
  vlmModelName: env.vlmModelName || '',
  useResponsesApi: false,
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
  operator: Operator.LocalComputer,
  reportStorageBaseUrl: '',
  utioBaseUrl: '',
};

export class SettingStore {
  private static instance: ElectronStore<LocalStore>;

  public static getInstance(): ElectronStore<LocalStore> {
    if (!SettingStore.instance) {
      SettingStore.instance = new ElectronStore<LocalStore>({
        name: 'ui_tars.setting',
        defaults: DEFAULT_SETTING,
      });

      // If existing on-disk store has empty VLM credentials, seed from env/defaults
      const current = SettingStore.instance.store;
      if (!current.vlmProvider || (current.vlmProvider as string) === '') {
        SettingStore.instance.set(
          'vlmProvider',
          (env.vlmProvider as VLMProviderV2) || VLMProviderV2.nvidia,
        );
      }
      if (!current.vlmBaseUrl || current.vlmBaseUrl === '') {
        if (env.vlmBaseUrl) {
          SettingStore.instance.set('vlmBaseUrl', env.vlmBaseUrl);
        }
      }
      if (!current.vlmApiKey || current.vlmApiKey === '') {
        if (env.vlmApiKey) {
          SettingStore.instance.set('vlmApiKey', env.vlmApiKey);
        }
      }
      if (!current.vlmModelName || current.vlmModelName === '') {
        if (env.vlmModelName) {
          SettingStore.instance.set('vlmModelName', env.vlmModelName);
        }
      }

      SettingStore.instance.onDidAnyChange((newValue, oldValue) => {
        logger.log(
          `SettingStore: ${JSON.stringify(oldValue)} changed to ${JSON.stringify(newValue)}`,
        );
        // Notify that value updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('setting-updated', newValue);
        });
      });
    }
    return SettingStore.instance;
  }

  public static set<K extends keyof LocalStore>(
    key: K,
    value: LocalStore[K],
  ): void {
    SettingStore.getInstance().set(key, value);
  }

  public static setStore(state: LocalStore): void {
    SettingStore.getInstance().set(state);
  }

  public static get<K extends keyof LocalStore>(key: K): LocalStore[K] {
    const val = SettingStore.getInstance().get(key);
    if (!val || (val as unknown as string) === '') {
      if (key === 'vlmProvider')
        return (
          (env.vlmProvider as LocalStore[K]) ||
          (VLMProviderV2.nvidia as LocalStore[K])
        );
      if (key === 'vlmBaseUrl')
        return (env.vlmBaseUrl as LocalStore[K]) || ('' as LocalStore[K]);
      if (key === 'vlmApiKey')
        return (env.vlmApiKey as LocalStore[K]) || ('' as LocalStore[K]);
      if (key === 'vlmModelName')
        return (env.vlmModelName as LocalStore[K]) || ('' as LocalStore[K]);
    }
    return val;
  }

  public static remove<K extends keyof LocalStore>(key: K): void {
    SettingStore.getInstance().delete(key);
  }

  public static getStore(): LocalStore {
    const raw = SettingStore.getInstance().store;
    return {
      ...raw,
      vlmProvider:
        raw.vlmProvider ||
        (env.vlmProvider as VLMProviderV2) ||
        VLMProviderV2.nvidia,
      vlmBaseUrl: raw.vlmBaseUrl || env.vlmBaseUrl || '',
      vlmApiKey: raw.vlmApiKey || env.vlmApiKey || '',
      vlmModelName: raw.vlmModelName || env.vlmModelName || '',
    };
  }

  public static clear(): void {
    SettingStore.getInstance().set(DEFAULT_SETTING);
  }

  public static openInEditor(): void {
    SettingStore.getInstance().openInEditor();
  }

  public static async importPresetFromUrl(
    url: string,
    autoUpdate = false,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch preset: ${response.status}`);
      }

      const yamlText = await response.text();
      const preset = yaml.load(yamlText);
      const validatedPreset = validatePreset(preset);

      SettingStore.setStore({
        ...validatedPreset,
        presetSource: {
          type: 'remote',
          url,
          autoUpdate,
          lastUpdated: Date.now(),
        },
      });
    } catch (error) {
      logger.error(error);
      throw new Error(
        `Failed to import preset: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public static async importPresetFromText(
    yamlContent: string,
  ): Promise<LocalStore> {
    try {
      const settings = await parsePresetYaml(yamlContent);
      return settings;
    } catch (error) {
      logger.error('Failed to import preset from text:', error);
      throw error;
    }
  }

  public static async fetchPresetFromUrl(url: string): Promise<LocalStore> {
    try {
      const response = await fetch(url);
      const yamlContent = await response.text();
      return await this.importPresetFromText(yamlContent);
    } catch (error) {
      logger.error('Failed to fetch preset from URL:', error);
      throw error;
    }
  }
}

async function parsePresetYaml(yamlContent: string): Promise<LocalStore> {
  const preset = yaml.load(yamlContent);
  const validatedPreset = validatePreset(preset);
  return validatedPreset;
}
