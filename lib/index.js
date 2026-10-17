import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as DshLlm from '@deepseek-ai/dsh-llm';
import { QuotaStore } from './store.js';
import { createLimiter } from './limiter.js';
import { BASE_PATH, createHttpHandler } from './http.js';
import { PriceCatalog } from './price-catalog.js';
import { estimateRequestTokens } from './request-estimate.js';

const { LlmError } = DshLlm;

export const name = 'quota-plan';
export const inject = ['llm'];

export function apply(ctx, options = {}) {
  // A shared home-level ledger spans sessions and profiles. Users can select
  // a separate file in the profile patch when they want independent budgets.
  const dataFile = options.dataFile ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'quota-plan', 'ledger.json');
  let store;
  let limiter;
  let priceCatalog;
  try {
    store = new QuotaStore(dataFile, { deferOnLockBusy: true });
    priceCatalog = new PriceCatalog({ file: options.priceCacheFile ?? resolve(dirname(dataFile), 'prices.json'),
      getConfig: () => store.status().config });
    limiter = createLimiter({ store, priceCatalog,
      modelInfo: request => ctx.llm.resolveModelInfo(request.provider, request.model, request.signal),
      estimateInput: (request, info) => estimateRequestTokens(request, {
        projectRequest: info && typeof DshLlm.projectToolUpdates === 'function'
          ? input => {
            const messages = Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')
              && typeof DshLlm.projectImagesForTextModel === 'function'
              ? DshLlm.projectImagesForTextModel(input.messages) : input.messages;
            return DshLlm.projectToolUpdates(messages, input.tools, info.toolUpdate, input.toolHistory);
          }
          : undefined,
        priceImages: typeof ctx.llm.imageRequestPricing === 'function'
          ? images => ctx.llm.imageRequestPricing(request.provider, request.model)?.priceImages(images)
          : undefined,
        fileText: typeof ctx.llm.fileRequestText === 'function'
          ? attachment => ctx.llm.fileRequestText(attachment) : undefined,
      }),
      errorFactory: (message, code) => new LlmError(`[DSH Plan] ${message}`, code),
    });
    ctx.on('llm/stream', limiter.stream, { prepend: true });
    ctx.effect(() => { priceCatalog.start(); return () => priceCatalog.stop(); });
  } catch (error) {
    // A broken ledger must not unload the only restriction and let calls pass.
    ctx.on('llm/stream', async function* () {
      throw new LlmError(`[DSH Plan] 额度插件初始化失败，已停止模型调用：${error.message}`, 'PLAN_LEDGER_ERROR');
    }, { prepend: true });
    ctx.logger?.error?.(`[DSH Plan] ${error.message}`);
    return;
  }
  ctx.inject(['webServer', 'connection'], child => {
    const { handler } = createHttpHandler({ store, limiter, priceCatalog, connection: child.connection,
      getProviders: () => ctx.llm.listProviders() });
    child.effect(() => child.webServer.register({ kind: 'prefix', path: BASE_PATH, handler }));
  });
}
