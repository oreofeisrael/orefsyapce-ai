const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4';

export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.status = options.status || 502;
    this.code = options.code || 'provider_error';
    this.detail = options.detail || '';
    this.provider = options.provider || '';
    this.model = options.model || '';
  }
}

const parseJson = value => { try { return JSON.parse(value); } catch { return null; } };
const modelKey = (provider, id) => `${provider}:${id}`;
const toOpenAiMessages = messages => messages.map(message => ({ role: message.role, content: message.content }));
const toGeminiContents = messages => messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`;

function providerFailure(status, detail, provider, model) {
  const normalized = String(detail || '').toLowerCase();
  if (status === 401 || status === 403) return new ProviderError(`${provider} authentication failed. Check its server-side API key.`, { status: 502, code: 'provider_auth', detail, provider, model });
  if (status === 402 || /credit|balance|payment|billing/.test(normalized)) return new ProviderError(`${provider} rejected the request because credits or billing are unavailable.`, { status: 402, code: 'insufficient_credits', detail, provider, model });
  if (status === 404 || /model.*(not found|invalid)|unknown model/.test(normalized)) return new ProviderError(`The selected model is not available on ${provider}.`, { status: 400, code: 'invalid_model', detail, provider, model });
  if (status === 429 || /rate limit|too many requests|quota|resource exhausted/.test(normalized)) return new ProviderError(`${provider} rate limit or quota reached.`, { status: 429, code: 'rate_limited', detail, provider, model });
  return new ProviderError(`${provider} rejected the request.`, { status: status >= 500 ? 502 : status, code: status >= 500 ? 'provider_failure' : 'provider_error', detail, provider, model });
}

async function request(url, options, timeoutMs, provider, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
  }
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw providerFailure(response.status, await response.text(), provider, model);
    return response;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error.name === 'AbortError' || controller.signal.reason === 'timeout') throw new ProviderError(`${provider} request timed out.`, { status: 504, code: 'upstream_timeout', provider, model });
    throw new ProviderError(`Network request to ${provider} failed.`, { status: 502, code: 'network_error', detail: error.message, provider, model });
  } finally { clearTimeout(timeout); }
}

function commonModel(provider, providerName, model) {
  return { ...model, key: modelKey(provider, model.id), provider, providerName, configured: Boolean(model.configured), freeStatus: model.freeStatus || 'Availability varies', notes: model.notes || '' };
}

function pricingStatus(prompt, completion) {
  if (prompt === '0' && completion === '0') return 'Free';
  if (prompt || completion) return 'Paid / varies';
  return 'Pricing unavailable';
}

export function createProviderRegistry({ env, timeoutMs, maxOutputTokens }) {
  const providers = {
    openrouter: { name: 'OpenRouter', key: env.OPENROUTER_API_KEY, freeStatus: 'Free or paid by model', notes: 'OpenAI-compatible gateway with provider routing.' },
    groq: { name: 'Groq', key: env.GROQ_API_KEY, freeStatus: 'Free tier with account limits', notes: 'OpenAI-compatible API. Exact limits vary by account and model.' },
    gemini: { name: 'Google Gemini', key: env.GEMINI_API_KEY, freeStatus: 'Free tier with limited access', notes: 'Google free tier is limited and may use content to improve products.' },
    cloudflare: { name: 'Cloudflare Workers AI', key: env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID, freeStatus: '10,000 neurons/day on Workers Free', notes: 'Some Workers AI models require paid billing.' }
  };
  let cloudflareModels = [];
  try { cloudflareModels = env.CLOUDFLARE_WORKERS_AI_MODELS ? JSON.parse(env.CLOUDFLARE_WORKERS_AI_MODELS) : []; } catch { cloudflareModels = []; }
  if (!cloudflareModels.length) cloudflareModels = [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct', contextLength: 24576, capabilities: ['text'], freeStatus: 'Free allocation; limits apply', notes: 'Default Workers AI model; verify current availability.' }];

  async function listOpenRouter() {
    if (!providers.openrouter.key) return [];
    const response = await request(`${OPENROUTER_BASE}/models`, { headers: { Authorization: `Bearer ${providers.openrouter.key}` } }, timeoutMs, 'OpenRouter', 'catalogue');
    const payload = await response.json();
    return (payload.data || []).map(model => commonModel('openrouter', providers.openrouter.name, { id: model.id, name: model.name || model.id, contextLength: model.context_length, capabilities: [...(model.architecture?.input_modalities || []), ...(model.supported_parameters || [])], supportsVision: Boolean(model.architecture?.input_modalities?.includes('image')), supportsReasoning: Boolean(model.supported_parameters?.includes('reasoning')), configured: true, freeStatus: pricingStatus(model.pricing?.prompt, model.pricing?.completion), promptPrice: model.pricing?.prompt, completionPrice: model.pricing?.completion }));
  }

  async function listGroq() {
    if (!providers.groq.key) return [];
    const response = await request(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${providers.groq.key}` } }, timeoutMs, 'Groq', 'catalogue');
    const payload = await response.json();
    return (payload.data || []).map(model => commonModel('groq', providers.groq.name, { id: model.id, name: model.name || model.id, contextLength: model.context_window, capabilities: ['text'], configured: true, freeStatus: providers.groq.freeStatus, notes: providers.groq.notes }));
  }

  async function listGemini() {
    if (!providers.gemini.key) return [];
    const response = await request(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': providers.gemini.key } }, timeoutMs, 'Google Gemini', 'catalogue');
    const payload = await response.json();
    return (payload.models || []).filter(model => (model.supportedGenerationMethods || []).includes('generateContent')).map(model => commonModel('gemini', providers.gemini.name, { id: model.name.replace(/^models\//, ''), name: model.displayName || model.name, contextLength: model.inputTokenLimit, maxOutputTokens: model.outputTokenLimit, capabilities: model.supportedGenerationMethods || [], supportsVision: false, configured: true, freeStatus: providers.gemini.freeStatus, notes: providers.gemini.notes }));
  }

  function listCloudflare() {
    return cloudflareModels.map(model => commonModel('cloudflare', providers.cloudflare.name, { ...model, configured: Boolean(providers.cloudflare.key), capabilities: model.capabilities || ['text'], freeStatus: model.freeStatus || providers.cloudflare.freeStatus, notes: model.notes || providers.cloudflare.notes }));
  }

  async function listModels() {
    const results = await Promise.allSettled([listOpenRouter(), listGroq(), listGemini()]);
    const models = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') models.push(...result.value);
      else console.error(['OpenRouter', 'Groq', 'Google Gemini'][index], 'catalogue failed:', result.reason?.message || result.reason);
    });
    if (providers.openrouter.key) models.unshift(commonModel('openrouter', providers.openrouter.name, { id: 'openrouter/free', name: 'OpenRouter Free Router', contextLength: null, capabilities: ['text'], configured: true, freeStatus: 'Free router; availability and limits vary', notes: 'Routes to currently available free models.' }));
    models.push(...listCloudflare());
    return { models, providers: Object.entries(providers).map(([id, provider]) => ({ id, name: provider.name, configured: Boolean(provider.key), freeStatus: provider.freeStatus, notes: provider.notes })) };
  }

  function resolve(key) {
    const raw = String(key || '');
    const separator = raw.indexOf(':');
    const providerId = separator > 0 ? raw.slice(0, separator) : 'openrouter';
    const id = separator > 0 ? raw.slice(separator + 1) : raw;
    const provider = providers[providerId];
    if (!provider) throw new ProviderError(`Unknown provider: ${providerId}.`, { status: 400, code: 'unknown_provider', provider: providerId, model: id });
    if (!provider.key) throw new ProviderError(`${provider.name} is not configured on the server.`, { status: 503, code: 'provider_not_configured', provider: providerId, model: id });
    return { providerId, provider, id };
  }

  async function chat({ key, messages, signal }) {
    const target = resolve(key);
    if (target.providerId === 'openrouter' || target.providerId === 'groq') {
      const base = target.providerId === 'openrouter' ? OPENROUTER_BASE : GROQ_BASE;
      const headers = { Authorization: `Bearer ${target.provider.key}`, 'Content-Type': 'application/json' };
      if (target.providerId === 'openrouter') { headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL || 'http://localhost:3000'; headers['X-Title'] = env.OPENROUTER_APP_NAME || 'Orefyspace AI'; }
      const response = await request(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: target.id, messages: toOpenAiMessages(messages), stream: true, max_completion_tokens: maxOutputTokens }), signal }, timeoutMs, target.provider.name, target.id);
      return { ...target, response, format: 'openai-sse', streaming: true };
    }
    if (target.providerId === 'gemini') {
      const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      const response = await request(`${GEMINI_BASE}/models/${encodeURIComponent(target.id)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'x-goog-api-key': target.provider.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: toGeminiContents(messages), generationConfig: { maxOutputTokens } }), signal }, timeoutMs, target.provider.name, target.id);
      return { ...target, response, format: 'gemini-sse', streaming: true };
    }
    const prompt = messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n');
    const response = await request(`${CLOUDFLARE_BASE}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${encodeURIComponent(target.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }), signal }, timeoutMs, target.provider.name, target.id);
    return { ...target, response, format: 'cloudflare-json', streaming: false };
  }

  async function writeStream(result, response) {
    if (result.format === 'openai-sse') {
      const reader = result.response.body.getReader(); const decoder = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; response.write(value ? decoder.decode(value, { stream: true }) : ''); }
      return;
    }
    if (result.format === 'gemini-sse') {
      const reader = result.response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const events = buffer.split('\n\n'); buffer = events.pop() || '';
        for (const event of events) { const line = event.split('\n').find(value => value.startsWith('data: ')); if (!line) continue; const payload = parseJson(line.slice(6)); const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''; if (text) response.write(sse({ choices: [{ delta: { content: text } }] })); }
      }
      return;
    }
    const payload = await result.response.json(); const text = payload?.result?.response || payload?.result?.text || payload?.response || '';
    if (text) response.write(sse({ choices: [{ delta: { content: text } }] }));
  }

  return { listModels, chat, writeStream, providers };
}
