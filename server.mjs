import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderRegistry, ProviderError } from './providers.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
const conversationsFile = join(dataDir, 'conversations.json');
const projectsFile = join(dataDir, 'projects.json');
const promptsFile = join(dataDir, 'prompts.json');

// Keep the server dependency-free while still supporting the documented .env workflow.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const port = Number(process.env.PORT || 3000);
const defaultModel = process.env.OPENROUTER_MODEL || 'openrouter/free';
const defaultModelKey = defaultModel.includes(':') ? defaultModel : `openrouter:${defaultModel}`;
const databaseUrl = process.env.DATABASE_URL || '';
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
const requestTimeoutMs = clamp(Number(process.env.OPENROUTER_TIMEOUT_MS || 45_000), 5_000, 120_000, 45_000);
const maxBodyBytes = clamp(Number(process.env.MAX_REQUEST_BYTES || 1_000_000), 10_000, 5_000_000, 1_000_000);
const maxMessages = clamp(Number(process.env.MAX_MESSAGES || 50), 1, 100, 50);
const maxMessageChars = clamp(Number(process.env.MAX_MESSAGE_CHARS || 20_000), 100, 100_000, 20_000);
const maxConversationChars = clamp(Number(process.env.MAX_CONVERSATION_CHARS || 100_000), 1_000, 500_000, 100_000);
const maxOutputTokens = clamp(Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || 4_096), 16, 16_384, 4_096);
const allowedRoles = new Set(['system', 'user', 'assistant']);
const chatRateWindowMs = clamp(Number(process.env.CHAT_RATE_WINDOW_MS || 600_000), 60_000, 3_600_000, 600_000);
const chatRateLimit = clamp(Number(process.env.CHAT_RATE_LIMIT || 30), 1, 300, 30);
const rateBuckets = new Map();
const persistence = { mode: 'filesystem', pool: null, state: { conversations: [], projects: [], prompts: [] } };
const providerRegistry = createProviderRegistry({ env: process.env, timeoutMs: requestTimeoutMs, maxOutputTokens });

mkdirSync(dataDir, { recursive: true });
if (!existsSync(conversationsFile)) writeFileSync(conversationsFile, '[]', 'utf8');
if (!existsSync(projectsFile)) writeFileSync(projectsFile, '[]', 'utf8');
if (!existsSync(promptsFile)) writeFileSync(promptsFile, JSON.stringify([
  { id: randomUUID(), title: 'Code review brief', category: 'Coding', content: 'Review this code for correctness, maintainability, security, and test gaps. Return findings by severity with concrete fixes.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), title: 'Research synthesis', category: 'Research', content: 'Synthesize the provided research into key findings, disagreements, open questions, and a practical recommendation. Cite uncertainty clearly.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), title: 'Polished rewrite', category: 'Writing', content: 'Rewrite the text below so it is clear, concise, warm, and persuasive. Preserve the meaning and flag any unsupported claims.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), title: 'Workflow designer', category: 'Automation', content: 'Design an automation workflow for this goal. Include trigger, steps, data passed between steps, failure handling, and a simple implementation plan.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
], null, 2), 'utf8');

const json = (value, status = 200) => ({ status, body: JSON.stringify(value), headers: { 'content-type': 'application/json; charset=utf-8' } });

function readConversations() {
  return persistence.state.conversations;
}

async function saveConversations(conversations) {
  persistence.state.conversations = conversations;
  await persistWorkspace();
}

function readJsonFile(file, fallback = []) {
  if (file === projectsFile) return persistence.state.projects;
  if (file === promptsFile) return persistence.state.prompts;
  try { const value = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(value) ? value : fallback; } catch { return fallback; }
}

async function saveJsonFile(file, value) {
  if (file === projectsFile) persistence.state.projects = value;
  if (file === promptsFile) persistence.state.prompts = value;
  await persistWorkspace();
}

async function initializePersistence() {
  persistence.state = {
    conversations: readFileArray(conversationsFile),
    projects: readFileArray(projectsFile),
    prompts: readFileArray(promptsFile)
  };
  if (!databaseUrl) return;
  try {
    const { Pool } = await import('pg');
    persistence.pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 5 });
    await persistence.pool.query(`CREATE TABLE IF NOT EXISTS orefyspace_workspace_state (id TEXT PRIMARY KEY, conversations JSONB NOT NULL DEFAULT '[]', projects JSONB NOT NULL DEFAULT '[]', prompts JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const result = await persistence.pool.query('SELECT conversations, projects, prompts FROM orefyspace_workspace_state WHERE id = $1', ['default']);
    if (result.rows[0]) {
      persistence.state = { conversations: result.rows[0].conversations || [], projects: result.rows[0].projects || [], prompts: result.rows[0].prompts || [] };
    } else {
      await persistWorkspace();
    }
    persistence.mode = 'postgres';
    console.log('Persistent storage: PostgreSQL');
  } catch (error) {
    persistence.pool = null;
    persistence.mode = 'filesystem-fallback';
    console.error('PostgreSQL initialization failed; using local files. Set DATABASE_URL correctly before production deployment.', error);
  }
}

function readFileArray(file) {
  try { const value = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; }
}

async function persistWorkspace() {
  if (persistence.pool) {
    await persistence.pool.query(`INSERT INTO orefyspace_workspace_state (id, conversations, projects, prompts, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET conversations = EXCLUDED.conversations, projects = EXCLUDED.projects, prompts = EXCLUDED.prompts, updated_at = NOW()`, ['default', JSON.stringify(persistence.state.conversations), JSON.stringify(persistence.state.projects), JSON.stringify(persistence.state.prompts)]);
    return;
  }
  writeFileSync(conversationsFile, JSON.stringify(persistence.state.conversations, null, 2), 'utf8');
  writeFileSync(projectsFile, JSON.stringify(persistence.state.projects, null, 2), 'utf8');
  writeFileSync(promptsFile, JSON.stringify(persistence.state.prompts, null, 2), 'utf8');
}

async function persistenceHealth() {
  if (!persistence.pool) return { mode: persistence.mode, persistent: false };
  try { await persistence.pool.query('SELECT 1'); return { mode: persistence.mode, persistent: true }; }
  catch { return { mode: 'postgres-unhealthy', persistent: false }; }
}

function clientKey(request) { return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'local'; }

function checkChatRateLimit(request) {
  const key = clientKey(request);
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter(timestamp => now - timestamp < chatRateWindowMs);
  if (bucket.length >= chatRateLimit) {
    const error = new Error('Chat rate limit reached. Please wait before trying again.'); error.status = 429; error.code = 'local_rate_limited'; throw error;
  }
  bucket.push(now); rateBuckets.set(key, bucket);
}

function cleanText(value, fallback = '', max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : fallback; }

function validateProjectInput(input) {
  const name = cleanText(input?.name, '', 80);
  if (!name) { const error = new Error('Project name is required.'); error.status = 400; throw error; }
  return { name, description: cleanText(input?.description, '', 240), color: cleanText(input?.color, '#00F05A', 20) };
}

function validatePromptInput(input) {
  const title = cleanText(input?.title, '', 120);
  const content = cleanText(input?.content, '', maxMessageChars);
  if (!title || !content) { const error = new Error('Prompt title and content are required.'); error.status = 400; throw error; }
  return { title, content, category: cleanText(input?.category, 'General', 40) };
}

function send(response, payload) {
  response.writeHead(payload.status, { ...payload.headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  response.end(payload.body);
}

function body(request) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    request.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) {
        const error = new Error(`Request body exceeds the ${maxBodyBytes.toLocaleString()} byte limit.`);
        error.status = 413;
        request.resume();
        fail(error);
      }
    });
    request.on('end', () => {
      if (settled) return;
      try { settled = true; resolveBody(raw ? JSON.parse(raw) : {}); }
      catch (error) { error.status = 400; settled = false; fail(error); }
    });
    request.on('error', fail);
  });
}

function redactSecrets(value = '') {
  return String(value).replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1_200);
}

function providerDetail(text) {
  try {
    const payload = JSON.parse(text);
    return payload?.error?.message || payload?.message || text;
  } catch { return text; }
}

function classifyProviderError(status, detail = '') {
  const normalized = redactSecrets(detail).toLowerCase();
  if (status === 401 || status === 403) return { status: 502, code: 'openrouter_auth', error: 'OpenRouter authentication failed. Check OPENROUTER_API_KEY on the server.' };
  if (status === 402 || /insufficient|credits|balance|payment/.test(normalized)) return { status: 402, code: 'insufficient_credits', error: 'OpenRouter rejected the request because the account has insufficient credits.' };
  if (status === 404 || /model.*(not found|invalid)|unknown model/.test(normalized)) return { status: 400, code: 'invalid_model', error: 'The selected model is not available on OpenRouter.' };
  if (status === 408 || status === 504) return { status: 504, code: 'upstream_timeout', error: 'OpenRouter timed out before producing a response.' };
  if (status === 429 || /rate limit|too many requests/.test(normalized)) return { status: 429, code: 'rate_limited', error: 'OpenRouter rate-limited this request. Wait a moment and try again.' };
  if (status >= 500) return { status: 502, code: 'provider_failure', error: 'The upstream model provider failed while processing the request.' };
  return { status: status >= 400 ? status : 502, code: 'openrouter_error', error: 'OpenRouter rejected the request.' };
}

function sendError(response, status, error, code, detail = '') {
  return send(response, json({ error, code, ...(detail ? { detail: redactSecrets(detail) } : {}) }, status));
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error('At least one conversation message is required.'); error.status = 400; throw error;
  }
  if (messages.length > maxMessages) {
    const error = new Error(`A conversation may contain at most ${maxMessages} messages.`); error.status = 413; throw error;
  }
  let totalChars = 0;
  const validated = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || !allowedRoles.has(message.role) || typeof message.content !== 'string' || !message.content.trim()) {
      const error = new Error(`Message ${index + 1} must include a supported role and non-empty text content.`); error.status = 400; throw error;
    }
    if (message.content.length > maxMessageChars) {
      const error = new Error(`Message ${index + 1} exceeds the ${maxMessageChars.toLocaleString()} character limit.`); error.status = 413; throw error;
    }
    totalChars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalChars > maxConversationChars) {
    const error = new Error(`The conversation exceeds the ${maxConversationChars.toLocaleString()} character limit.`); error.status = 413; throw error;
  }
  return validated;
}

function validateChatInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) { const error = new Error('Request body must be a JSON object.'); error.status = 400; throw error; }
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : defaultModelKey;
  if (model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model)) { const error = new Error('The selected model ID is invalid.'); error.status = 400; throw error; }
  return { model, messages: validateMessages(input.messages) };
}

function normalizeConversation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) { const error = new Error('Conversation payload must be a JSON object.'); error.status = 400; throw error; }
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : 'New conversation';
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages = rawMessages.length ? validateMessages(rawMessages.map(message => ({ role: message.role, content: message.content }))) : [];
  const serializedChars = JSON.stringify({ title, messages }).length;
  if (serializedChars > maxConversationChars + 2_000) { const error = new Error('The saved conversation is too large.'); error.status = 413; throw error; }
  return {
    title: title || 'New conversation',
    messages,
    projectId: typeof input.projectId === 'string' && input.projectId.length <= 100 ? input.projectId : null,
    model: cleanText(input.model, '', 200),
    archived: Boolean(input.archived)
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === 'AbortError' || controller.signal.reason === 'timeout') { const timeoutError = new Error('The upstream request timed out.'); timeoutError.code = 'upstream_timeout'; timeoutError.status = 504; throw timeoutError; }
    throw error;
  } finally { clearTimeout(timeout); }
}

async function handleChat(request, response) {
  checkChatRateLimit(request);
  const input = await body(request);
  const { model, messages } = validateChatInput(input);
  const controller = new AbortController();
  let clientClosed = false;
  const abortForClient = () => { clientClosed = true; controller.abort('client_cancelled'); };
  request.on('aborted', abortForClient);
  response.on('close', () => { if (!response.writableEnded) abortForClient(); });
  let result;
  try {
    result = await tryProviderWithFallback(controller, model, messages);
  } catch (error) {
    if (clientClosed) return;
    if (error instanceof ProviderError) return sendError(response, error.status, error.message, error.code, error.detail);
    return sendError(response, 502, 'Provider request failed.', 'provider_failure', error.message);
  }

  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.write(`data: ${JSON.stringify({ type: 'meta', provider: result.provider.name, providerId: result.providerId, model: result.id, streaming: result.streaming, fallbackFrom: result.fallbackFrom || null, fallbackReason: result.fallbackReason || null })}\n\n`);
  try {
    await providerRegistry.writeStream(result, response);
    response.write('data: [DONE]\n\n');
  } catch (error) {
    if (!clientClosed) response.write(`data: ${JSON.stringify({ error: error.message || 'The provider stream ended unexpectedly.' })}\n\n`);
  } finally {
    if (!response.writableEnded) response.end();
  }
}

async function listProviderModels() {
  const result = await providerRegistry.listModels();
  return { data: result.models, providers: result.providers, defaultModel: defaultModelKey, demo: !result.providers.some(provider => provider.configured) };
}

function fallbackCandidates(requestedModel) {
  const configured = (process.env.PROVIDER_FALLBACK_CHAIN || '').split(',').map(value => value.trim()).filter(Boolean);
  return configured.filter(candidate => candidate !== requestedModel);
}

async function tryProviderWithFallback(request, model, messages) {
  try {
    return await providerRegistry.chat({ key: model, messages, signal: request.signal });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    for (const candidate of fallbackCandidates(model)) {
      try {
        const result = await providerRegistry.chat({ key: candidate, messages, signal: request.signal });
        return { ...result, fallbackFrom: model, fallbackReason: error.message };
      } catch (fallbackError) {
        if (fallbackError instanceof ProviderError) continue;
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function handleApi(request, response, pathname) {
  try {
    if (request.method === 'GET' && pathname === '/api/health') return send(response, json({ ok: true, demo: !Object.values(providerRegistry.providers).some(provider => provider.key), defaultModel: defaultModelKey, providers: Object.entries(providerRegistry.providers).map(([id, provider]) => ({ id, name: provider.name, configured: Boolean(provider.key) })), ...(await persistenceHealth()) }));
    if (request.method === 'GET' && pathname === '/api/models') return send(response, json(await listProviderModels()));
    if (request.method === 'GET' && pathname === '/api/conversations') {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const includeArchived = url.searchParams.get('archived') === 'true';
      const projectId = url.searchParams.get('projectId');
      let conversations = readConversations();
      if (!includeArchived) conversations = conversations.filter(item => !item.archived);
      if (projectId) conversations = conversations.filter(item => item.projectId === projectId);
      return send(response, json(conversations));
    }
    if (request.method === 'GET' && pathname === '/api/projects') return send(response, json(readJsonFile(projectsFile)));
    if (request.method === 'POST' && pathname === '/api/projects') {
      const input = await body(request); const project = { id: randomUUID(), ...validateProjectInput(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const projects = readJsonFile(projectsFile); projects.unshift(project); await saveJsonFile(projectsFile, projects.slice(0, 100)); return send(response, json(project, 201));
    }
    if (request.method === 'PATCH' && pathname.startsWith('/api/projects/')) {
      const id = decodeURIComponent(pathname.split('/').pop()); const input = await body(request); const projects = readJsonFile(projectsFile); const index = projects.findIndex(item => item.id === id);
      if (index < 0) return sendError(response, 404, 'Project not found.', 'not_found'); projects[index] = { ...projects[index], ...validateProjectInput({ ...projects[index], ...input }), updatedAt: new Date().toISOString() }; await saveJsonFile(projectsFile, projects); return send(response, json(projects[index]));
    }
    if (request.method === 'DELETE' && pathname.startsWith('/api/projects/')) {
      const id = decodeURIComponent(pathname.split('/').pop()); await saveJsonFile(projectsFile, readJsonFile(projectsFile).filter(item => item.id !== id)); const conversations = readConversations().map(item => item.projectId === id ? { ...item, projectId: null } : item); await saveConversations(conversations); return send(response, json({ ok: true }));
    }
    if (request.method === 'GET' && pathname === '/api/prompts') return send(response, json(readJsonFile(promptsFile)));
    if (request.method === 'POST' && pathname === '/api/prompts') {
      const input = await body(request); const prompt = { id: randomUUID(), ...validatePromptInput(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const prompts = readJsonFile(promptsFile); prompts.unshift(prompt); await saveJsonFile(promptsFile, prompts.slice(0, 500)); return send(response, json(prompt, 201));
    }
    if (request.method === 'PATCH' && pathname.startsWith('/api/prompts/')) {
      const id = decodeURIComponent(pathname.split('/').pop()); const input = await body(request); const prompts = readJsonFile(promptsFile); const index = prompts.findIndex(item => item.id === id);
      if (index < 0) return sendError(response, 404, 'Prompt not found.', 'not_found'); prompts[index] = { ...prompts[index], ...validatePromptInput({ ...prompts[index], ...input }), updatedAt: new Date().toISOString() }; await saveJsonFile(promptsFile, prompts); return send(response, json(prompts[index]));
    }
    if (request.method === 'DELETE' && pathname.startsWith('/api/prompts/')) {
      const id = decodeURIComponent(pathname.split('/').pop()); await saveJsonFile(promptsFile, readJsonFile(promptsFile).filter(item => item.id !== id)); return send(response, json({ ok: true }));
    }
    if (request.method === 'GET' && pathname.startsWith('/api/conversations/') && pathname.endsWith('/export')) {
      const parts = pathname.split('/'); const id = decodeURIComponent(parts[3]); const conversation = readConversations().find(item => item.id === id);
      if (!conversation) return sendError(response, 404, 'Conversation not found.', 'not_found');
      const markdown = `# ${conversation.title}\n\nModel: ${conversation.model || defaultModel}\n\n${(conversation.messages || []).map(message => `## ${message.role === 'user' ? 'You' : 'Orefyspace AI'}\n\n${message.content}`).join('\n\n')}`;
      return send(response, { status: 200, body: markdown, headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${conversation.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'conversation'}.md"` } });
    }
    if (request.method === 'POST' && pathname === '/api/conversations') {
      const input = await body(request);
      const normalized = normalizeConversation(input);
      const now = new Date().toISOString();
      const conversation = { id: typeof input.id === 'string' && input.id.length <= 100 ? input.id : randomUUID(), ...normalized, createdAt: input.createdAt || now, updatedAt: now };
      const conversations = readConversations().filter(item => item.id !== conversation.id);
      conversations.unshift(conversation);
      await saveConversations(conversations.slice(0, 100));
      return send(response, json(conversation, 201));
    }
    if (request.method === 'PATCH' && pathname.startsWith('/api/conversations/')) {
      const id = decodeURIComponent(pathname.split('/').pop());
      const input = await body(request);
      const normalized = normalizeConversation({ ...readConversations().find(item => item.id === id), ...input });
      const conversations = readConversations();
      const index = conversations.findIndex(item => item.id === id);
      if (index < 0) return send(response, json({ error: 'Conversation not found.' }, 404));
      conversations[index] = { ...conversations[index], ...normalized, id, updatedAt: new Date().toISOString() };
      await saveConversations(conversations);
      return send(response, json(conversations[index]));
    }
    if (request.method === 'DELETE' && pathname.startsWith('/api/conversations/')) {
      const id = decodeURIComponent(pathname.split('/').pop());
      const conversations = readConversations().filter(item => item.id !== id);
      await saveConversations(conversations);
      return send(response, json({ ok: true }));
    }
    if (request.method === 'POST' && pathname === '/api/chat') return handleChat(request, response);
    return send(response, json({ error: 'Not found.' }, 404));
  } catch (error) {
    return sendError(response, error.status || 500, error.message || 'Unexpected server error.', error.code || 'server_error', error.detail || '');
  }
}

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(publicDir, `.${normalize(requested)}`);
  if (!filePath.startsWith(resolve(publicDir)) || !existsSync(filePath)) return send(response, json({ error: 'Not found.' }, 404));
  const contentTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
  response.writeHead(200, { 'content-type': `${contentTypes[extname(filePath)] || 'application/octet-stream'}; charset=utf-8`, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  response.end(readFileSync(filePath));
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url.pathname);
  return serveStatic(request, response, url.pathname);
});

server.on('clientError', (error, socket) => {
  console.error('HTTP client error:', error.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

initializePersistence().then(() => {
  const configuredProvider = Object.values(providerRegistry.providers).some(provider => provider.key);
  server.listen(port, '0.0.0.0', () => console.log(`Orefyspace AI running at http://0.0.0.0:${port}${configuredProvider ? '' : ' (demo mode)'} [${persistence.mode}]`));
}).catch(error => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});
