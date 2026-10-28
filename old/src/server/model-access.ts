import { createAssistantMessageEventStream, createModels } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { instrument } from '@flue/runtime';
import { providerAllowed } from './connectors.ts';
import { als } from './context.ts';
import { userOfConversation } from './usage.ts';

// Agent process. installModelAccess() wraps the pi-ai `Models` class itself (the one entry point Flue and every provider send model
// requests through) and refuses a request whose provider the conversation's user may not use (per-user providers: their owner only).

// Flue's interceptor runs next() inside our ALS scope: that is how the provider call learns the conversation id (also for delegated tasks and compaction).
instrument({ observe: () => {}, interceptor: (_op, ctx, next) => (ctx.instanceId ? als.run(ctx.instanceId, next) : next()), dispose: () => {} });

function failure(model: any, message: string): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: 'error', errorMessage: message, timestamp: Date.now() };
}

/** Every `Models` instance sends chat requests through stream/streamSimple (complete* call them), so patching the shared prototype covers all providers. */
let installed = false;
export function installModelAccess() {
  if (installed) return;
  installed = true;
  const proto = Object.getPrototypeOf(createModels());
  for (const name of ['stream', 'streamSimple'] as const) {
    const orig = proto[name];
    proto[name] = function (this: unknown, model: any, ctx: unknown, options?: unknown) {
      const id = als.getStore();
      const why = !id ? 'no conversation context for this model request' : !providerAllowed(userOfConversation(id) ?? '', model.provider) ? 'this model is not available to you' : '';
      if (!why) return orig.call(this, model, ctx, options);
      const out = createAssistantMessageEventStream();
      const error = failure(model, `Blocked: ${why}. Nothing was sent to the model.`);
      out.push({ type: 'error', reason: 'error', error });
      out.end(error);
      return out;
    };
  }
}
