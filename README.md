# Orefyspace AI

Orefyspace AI is a production-oriented, dark-first personal AI workspace powered by a configurable multi-provider gateway. It includes persistent conversations, projects, a reusable prompt library, live model discovery, per-conversation model selection, provider-aware streaming chat responses, export, archive, search, and explicit provider/quota errors.

## Current implementation

This workspace did not contain an existing web app or a Node/npm runtime, so the implementation uses a dependency-free browser frontend served by a small Node server. That keeps the application runnable without a build step while preserving the requested layout and server-side API-key boundary. The server is ready to sit behind a reverse proxy or be moved into a framework route handler later.

The official uploaded logo was not available as a workspace file at build time. The UI references `/orefyspace-logo.png` directly and falls back to an accessible text wordmark only until that official asset is placed in `public/`.

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. Set `OPENROUTER_API_KEY` in `.env` to enable live model responses.
4. Optionally set `OPENROUTER_MODEL` to your preferred default model.
5. Put the official Orefyspace logo at `public/orefyspace-logo.png`.
6. Start the app:

```bash
npm start
```

Open `http://localhost:3000`.

For development with automatic server restarts:

```bash
npm run dev
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | For live mode | Server-only OpenRouter API key. Never sent to the browser. |
| `OPENROUTER_MODEL` | No | Default OpenRouter model used when a provider prefix is omitted. The zero-cost starter value is `openrouter/free`; verify current availability and terms before deployment. |
| `OPENROUTER_SITE_URL` | No | Referer sent to OpenRouter for attribution. |
| `OPENROUTER_APP_NAME` | No | Application title sent to OpenRouter for attribution. |
| `GEMINI_API_KEY` | No | Backend-only Google Gemini API key. |
| `GROQ_API_KEY` | No | Backend-only Groq API key. |
| `CLOUDFLARE_API_TOKEN` | No | Backend-only Cloudflare API token with Workers AI permission. |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account ID for Workers AI. |
| `CLOUDFLARE_WORKERS_AI_MODELS` | No | Optional JSON array to replace the small default Workers AI model list. |
| `PROVIDER_FALLBACK_CHAIN` | No | Comma-separated provider/model keys used only when the requested provider fails, for example `groq:openai/gpt-oss-20b,openrouter:openrouter/free`. Fallback is explicit in the streamed metadata. |
| `DATABASE_URL` | No locally; recommended in deployment | PostgreSQL connection string. When present, the server uses durable PostgreSQL state instead of ephemeral local files. |
| `DATABASE_SSL` | No | Set to `true` for hosted PostgreSQL connections. |
| `OPENROUTER_TIMEOUT_MS` | No | Upstream timeout in milliseconds, defaults to `45000`. |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | No | Server-side output cap, defaults to `4096`. |
| `MAX_REQUEST_BYTES` | No | JSON request body limit, defaults to `1000000`. |
| `MAX_MESSAGES` | No | Maximum conversation turns accepted by `/api/chat`, defaults to `50`. |
| `MAX_MESSAGE_CHARS` | No | Maximum characters in one message, defaults to `20000`. |
| `MAX_CONVERSATION_CHARS` | No | Maximum combined message characters, defaults to `100000`. |
| `CHAT_RATE_WINDOW_MS` | No | In-memory chat rate-limit window, defaults to `600000`. |
| `CHAT_RATE_LIMIT` | No | Maximum chat requests per client per window, defaults to `30`. |
| `PORT` | No | Local HTTP port, defaults to `3000`. |

## Production deployment

- Run behind HTTPS and a reverse proxy such as Nginx, Caddy, or a platform-managed edge proxy.
- Set environment variables in the host's secret manager, not in the repository.
- Use `DATABASE_URL` with PostgreSQL/Supabase for deployment persistence. Local JSON storage is only a fallback for local development and ephemeral environments.
- Add authentication and rate limiting before exposing the server publicly. The current app is intentionally a single-workspace local deployment.
- Keep `OPENROUTER_API_KEY` server-side. The browser only calls `/api/models`, `/api/conversations`, and `/api/chat`.

## API surface

- `GET /api/health` — reports live/demo mode and default model.
- `GET /api/models` — retrieves provider catalogues server-side and returns normalized models with provider, capabilities, pricing/free-status notes, and configuration state. OpenRouter, Groq, and Gemini are queried dynamically; Workers AI is configurable through `CLOUDFLARE_WORKERS_AI_MODELS` because its model list is account/catalogue dependent.
- `GET /api/conversations` — loads active saved conversations. Supports `?archived=true` and `?projectId=...`.
- `POST /api/conversations` — creates or upserts a conversation.
- `PATCH /api/conversations/:id` — renames or updates a conversation.
- `DELETE /api/conversations/:id` — deletes a conversation.
- `GET /api/conversations/:id/export` — downloads a Markdown export.
- `GET /api/projects` — lists projects.
- `POST /api/projects` — creates a project.
- `PATCH /api/projects/:id` — updates a project.
- `DELETE /api/projects/:id` — deletes a project and unassigns its conversations.
- `GET /api/prompts` — lists saved prompts, including seeded coding, research, writing, and automation examples.
- `POST /api/prompts` — creates a saved prompt.
- `PATCH /api/prompts/:id` — edits a saved prompt.
- `DELETE /api/prompts/:id` — deletes a saved prompt.
- `POST /api/chat` — validates `{ model, messages }`, routes by provider key such as `openrouter:...`, `groq:...`, `gemini:...`, or `cloudflare:...`, adds the server-side output limit, and returns a normalized SSE stream.

### Chat request shape

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are Orefyspace AI." },
    { "role": "user", "content": "Help me plan this project." },
    { "role": "assistant", "content": "Sure — what are you building?" },
    { "role": "user", "content": "A personal AI workspace." }
  ]
}
```

The server accepts only `system`, `user`, and `assistant` roles with non-empty text content. It limits request size, message count, per-message size, total conversation size, and provider/model key length. The frontend sends previous turns from the active conversation so the selected model receives the relevant context. Model keys are persisted on conversations so the app does not silently change providers between turns.

### Error responses

Errors use a stable JSON shape:

```json
{
  "error": "OpenRouter rate-limited this request. Wait a moment and try again.",
  "code": "rate_limited"
}
```

The server maps common upstream failures to actionable codes including `openrouter_auth`, `invalid_model`, `rate_limited`, `insufficient_credits`, `provider_failure`, `upstream_timeout`, `network_error`, and `server_error`. Provider details are redacted and truncated before they reach the browser.

### Streaming and cancellation

`/api/chat` uses provider-specific adapters. OpenRouter and Groq use OpenAI-compatible streaming; Gemini uses `streamGenerateContent`; Cloudflare Workers AI uses its JSON inference route and is normalized into the same SSE shape. Aborting the browser request aborts the upstream request as well. Optional fallback candidates are only used when configured and the stream metadata tells the user which provider was selected after fallback.

## Demo mode and limitations

When no provider key is configured, the app visibly labels itself **Demo mode**, does not fabricate live model availability, and rejects chat requests with a provider configuration error instead of pretending the model responded. Add a backend key and restart the server for live responses.

Known limitations for this first production-oriented slice:

- Conversation, project, and prompt persistence use local JSON files (`data/conversations.json`, `data/projects.json`, and `data/prompts.json`) and are not multi-user safe.
- Authentication, billing, per-user quotas, and audit logging are not included. The chat limiter is in-memory and resets when the server restarts; it is not a substitute for a distributed rate limiter.
- Attachments currently add the selected filenames to the composer; file extraction and multimodal payloads still need a storage and security policy.
- Rename/delete uses a small prompt interaction rather than a full context menu.
- The JSON conversation store is suitable for a local single-user deployment only; use a database plus authentication before multi-user production use.
- The UI is intentionally dependency-free in this environment rather than a React/Tailwind build because the workspace has no existing frontend and no Node/npm runtime available to install or run a toolchain. The app's CSS tokens map directly to the requested palette and can be migrated into React/Tailwind components without changing the API contract.

For a real multi-user deployment, add authentication, a database-backed repository for conversations/projects/prompts, durable rate limiting, CSRF/origin protections appropriate to the deployment, and a secret manager. This implementation makes no claims of privacy, encryption, or account security beyond the server-side API-key boundary and the input limits described above.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the inspected architecture, recommended Render + Supabase zero-cost starting deployment, exact environment variable names, health-check verification, logs, hosting limits, OpenRouter cost caveats, and alternative hosting paths.
