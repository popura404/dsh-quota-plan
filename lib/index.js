import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { QuotaStore } from './store.js';
import { createLimiter } from './limiter.js';
import { BASE_PATH, createHttpHandler } from './http.js';

export const name = 'quota-plan';
export const inject = ['llm'];

export function apply(ctx, options = {}) {
  // A shared home-level ledger spans sessions and profiles. Users can select
  // a separate file in the profile patch when they want independent budgets.
  const dataFile = options.dataFile ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'quota-plan', 'ledger.json');
  let store;
  let limiter;
  try {
    store = new QuotaStore(dataFile);
    limiter = createLimiter({ store,
      modelInfo: request => ctx.llm.resolveModelInfo(request.provider, request.model, request.signal),
      errorFactory: (message, code) => new LlmError(`[DSH Plan] ${message}`, code),
    });
    ctx.on('agent/request', limiter.configureCall);
    ctx.on('llm/stream', limiter.stream, { prepend: true });
  } catch (error) {
    // A broken ledger must not unload the only restriction and let calls pass.
    ctx.on('llm/stream', async function* () {
      throw new LlmError(`[DSH Plan] 额度插件初始化失败，已停止模型调用：${error.message}`, 'PLAN_LEDGER_ERROR');
    }, { prepend: true });
    ctx.logger?.error?.(`[DSH Plan] ${error.message}`);
    return;
  }
  ctx.inject(['webServer', 'connection'], child => {
    const { handler } = createHttpHandler({ store, limiter, connection: child.connection });
    child.effect(() => child.webServer.register({ kind: 'prefix', path: BASE_PATH, handler }));
  });
}
