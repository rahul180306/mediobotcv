/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { AgentContext } from '../types';
import { DEFAULT_CONTEXT } from '../constants';

const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// @ts-ignore
const _globalThis: any = isBrowser ? window : global;

const GLOBAL_CONTEXT_KEY = Symbol.for('@ui-tars/sdk/context');
const ASYNC_STORAGE_KEY = Symbol.for('@ui-tars/sdk/async_context');

if (!_globalThis[GLOBAL_CONTEXT_KEY]) {
  _globalThis[GLOBAL_CONTEXT_KEY] = DEFAULT_CONTEXT;
}

if (!_globalThis[ASYNC_STORAGE_KEY] && typeof AsyncLocalStorage !== 'undefined') {
  _globalThis[ASYNC_STORAGE_KEY] = new AsyncLocalStorage<AgentContext>();
}

export function setContext(context: AgentContext): void {
  _globalThis[GLOBAL_CONTEXT_KEY] = context;
  const storage = _globalThis[ASYNC_STORAGE_KEY] as
    | AsyncLocalStorage<AgentContext>
    | undefined;
  if (storage) {
    storage.enterWith(context);
  }
}

/**
 * Runs a callback within an isolated AsyncLocalStorage context scope.
 * Guarantees that concurrent GUIAgent instances never cross-contaminate
 * logger, model, or abort signals.
 */
export function runWithContext<R>(context: AgentContext, fn: () => R): R {
  const storage = _globalThis[ASYNC_STORAGE_KEY] as
    | AsyncLocalStorage<AgentContext>
    | undefined;
  if (storage) {
    return storage.run(context, fn);
  }
  setContext(context);
  return fn();
}

export function useContext<T = AgentContext>(): T {
  const storage = _globalThis[ASYNC_STORAGE_KEY] as
    | AsyncLocalStorage<AgentContext>
    | undefined;
  const store = storage?.getStore();
  if (store) {
    return store as T;
  }
  return _globalThis[GLOBAL_CONTEXT_KEY] as T;
}
