# Orefyspace AI — zero-cost starting deployment

## 1. Architecture inspection

The generated application is a single Node.js service, not a static-only frontend:

- `public/` contains the browser UI: HTML, CSS, and browser JavaScript.
- `server.mjs` serves the UI and owns all `/api/*` routes.
- The server calls OpenRouter server-side, so the browser never receives `OPENROUTER_API_KEY`.
- Chat responses are streamed as SSE/chunked HTTP from `POST /api/chat`.
- The current persistence adapter uses local JSON files when `DATABASE_URL` is empty.
- When `DATABASE_URL` is set, the server uses PostgreSQL and creates an `orefyspace_workspace_state` table automatically.
- `/api/health` reports the active persistence mode and whether the database is reachable.

Because this is a full-stack Node server, deploying the frontend as a static site alone would break chat, model discovery, projects, prompts, persistence, and export. The recommended zero-cost starting architecture is therefore:

```text
GitHub repository
      ↓
Render Free Web Service
  ├─ serves public/
  ├─ runs server.mjs
  ├─ owns OPENROUTER_API_KEY
  └─ streams /api/chat
      ↓
Supabase Free PostgreSQL project
```

This is a development/hobby deployment, not a security or availability guarantee.

## 2. Recommended host: Render Free Web Service

Render supports Node web services, server-side environment variables, HTTP health checks, runtime logs, and dynamic server code. It is compatible with the current repository without splitting the frontend and backend. The included `render.yaml` already contains the service type, build command, start command, health path, and secret placeholders.

### Exact Render settings

If creating the service manually:

| Render field | Value |
| --- | --- |
| Service type | **Web Service** |
| Repository | Your GitHub repository containing this project |
| Branch | Your deployment branch, usually `main` |
| Root Directory | Leave empty unless this project is in a monorepo subdirectory |
| Runtime | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Plan | **Free** |
| Health Check Path | `/api/health` |

### Environment variables

Set these under **Render service → Environment → Environment Variables**:

| Key | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | Your server-only OpenRouter key. Never put this in GitHub or frontend code. |
| `OPENROUTER_MODEL` | `openrouter/free` for a current free-model router, or a model ID you have verified in the OpenRouter catalogue. |
| `GEMINI_API_KEY` | Optional Google Gemini server-side key. |
| `GROQ_API_KEY` | Optional Groq server-side key. |
| `CLOUDFLARE_API_TOKEN` | Optional Cloudflare API token with Workers AI permission. |
| `CLOUDFLARE_ACCOUNT_ID` | Optional Cloudflare account ID. |
| `CLOUDFLARE_WORKERS_AI_MODELS` | Optional JSON model catalogue for Workers AI. |
| `PROVIDER_FALLBACK_CHAIN` | Optional comma-separated fallback keys, such as `groq:openai/gpt-oss-20b,openrouter:openrouter/free`. |
| `OPENROUTER_SITE_URL` | Your Render URL, for example `https://orefyspace-ai.onrender.com` |
| `OPENROUTER_APP_NAME` | `Orefyspace AI` |
| `DATABASE_URL` | Supabase PostgreSQL connection string, described below |
| `DATABASE_SSL` | `true` |
| `OPENROUTER_TIMEOUT_MS` | `45000` |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | `4096` |
| `CHAT_RATE_LIMIT` | `30` |

The `render.yaml` uses `sync: false` for secrets so values are requested in the Render dashboard instead of committed to the repository.

### Render behavior to expect

- Free web services spin down after 15 minutes without inbound traffic and may take about one minute to wake on the next request.
- The local filesystem is ephemeral. Do not rely on `data/*.json` for production persistence.
- Free instances can restart at any time.
- Render provides 750 free instance hours per workspace per calendar month. Free bandwidth and build-pipeline quotas also apply.
- If a free service uses all included bandwidth and no payment method is present, Render suspends the free services for the rest of that month. Build limits can disable new builds.
- Free Render Postgres is not recommended for durable storage here because it expires after 30 days and has no backups.
- Render free services support logs, but request-level HTTP logs are a paid-workspace feature; application logs are still available in the service Logs page.

## 3. Persistent storage: Supabase Free PostgreSQL

Create a Supabase project on the Free plan, then open **Supabase Dashboard → Connect → Session pooler**. Copy the PostgreSQL connection string and set it as `DATABASE_URL` in Render. The shared/session pooler is the safer choice for an IPv4-only hosted service; do not put the database password in the repository.

The server automatically creates one JSONB-backed table:

```text
orefyspace_workspace_state
  id
  conversations JSONB
  projects JSONB
  prompts JSONB
  updated_at
```

### Supabase Free plan limits to plan around

Supabase documents a Free plan with two free projects, 500 MB database size per project, 5 GB egress, 1 GB file storage, and project pausing after one week of inactivity. The current app only uses PostgreSQL; it does not require Supabase Auth, Storage, or its browser Data API.

The application reports:

```json
GET /api/health
{
  "ok": true,
  "persistent": true,
  "mode": "postgres"
}
```

If the database cannot initialize, the server logs the failure and falls back to local files. For a deployment intended to survive restarts, treat `mode: filesystem-fallback` as a deployment failure and fix `DATABASE_URL` rather than accepting the fallback.

## 4. Deploy from GitHub

1. Commit and push this project to GitHub. Do not commit `.env`, `data/conversations.json`, `data/projects.json`, or `data/prompts.json`.
2. In Render, choose **New → Web Service** and connect the repository.
3. Use the exact settings above, or create a Render Blueprint from the included `render.yaml`.
4. Create the Supabase Free project and copy the **session pooler** connection string from **Connect**.
5. Add `OPENROUTER_API_KEY`, `DATABASE_URL`, and the remaining environment variables in Render.
6. Deploy.
7. Open `https://YOUR-SERVICE.onrender.com/api/health`.
8. Confirm `ok: true` and `persistent: true` with `mode: postgres`.
9. Open the root URL and test model loading, a chat request, project creation, prompt insertion, and conversation export.

Do not describe the application as deployed until step 8 and the user-flow test in step 9 have actually succeeded.

## 5. Multi-provider configuration and cost terms

Free hosting is not the same thing as free AI inference. OpenRouter's free plan and free-model catalogue are subject to current availability, model/provider-specific restrictions, and low rate limits. The `openrouter/free` router can choose from available free models, but it does not guarantee a particular model, latency, capability, or long-term availability.

If you use a specific model ID, verify it in OpenRouter immediately before deployment. Model pricing, context limits, provider availability, and data-use terms can change. Some free model pages explicitly warn that prompts and outputs may be retained or used for training, so do not claim private processing for this application.

The default in `render.yaml` is `openrouter/free` for a zero-cost starting point. Change it after checking the current model catalogue if you need predictable capabilities. Paid OpenRouter credits may be required for higher rate limits, paid models, or production reliability.

The provider abstraction accepts these model keys:

```text
openrouter:<openrouter-model-id>
groq:<groq-model-id>
gemini:<gemini-model-id>
cloudflare:<workers-ai-model-id>
```

Only configured providers are enabled for live chat. The model selector shows the provider, model ID, capabilities, and a status such as free-tier limited or paid/varies. It does not claim that any provider is unlimited or permanently free. Provider catalogues and limits should be re-checked before launch.

The provider source list for this implementation was based on the requested `awesome-free-llm-apis` reference, but the running adapter uses each provider's official API surface rather than scraping that repository. OpenRouter and Groq use OpenAI-compatible chat APIs; Gemini uses the official `generateContent`/streaming API; Cloudflare uses the Workers AI account inference endpoint. Exact free-tier eligibility and quotas remain account-, region-, model-, and date-dependent.

### Provider verification snapshot — October 24, 2026

- **OpenRouter:** its current free-model material documents `openrouter/free`, free models, and low free-model limits; OpenRouter's pricing page currently lists 50 requests/day on the Free plan, with free-model caps of 20 requests/minute and 50/day for a free account. Failed attempts can count against the daily free allowance. The app therefore labels OpenRouter as free-or-paid-by-model and handles quota errors instead of assuming unlimited access.
- **Google Gemini:** Google documents a Free tier with limited model access and free input/output tokens, but says content may be used to improve products on the Free tier. Google also documents project-level RPM/TPM/RPD quotas and `streamGenerateContent` SSE. The app marks Gemini as a limited free tier and keeps `GEMINI_API_KEY` server-side.
- **Groq:** Groq documents the OpenAI-compatible `/openai/v1/chat/completions` and `/openai/v1/models` endpoints. Its current rate-limit page says limits depend on organization and model, and lists current example limits for models such as `openai/gpt-oss-20b`; a 429 is handled explicitly. The app does not label Groq as unlimited.
- **Cloudflare Workers AI:** Cloudflare documents the REST route `/accounts/{account_id}/ai/run/{model_name}`, requires an API token and account ID, and currently provides 10,000 Neurons/day at no charge on the Free plan. Cloudflare also documents that some resource-intensive models require Workers Paid. The app exposes Workers AI as a configurable catalogue rather than pretending every catalogue model is free.

## 6. Health checks and logs

### Health check

Use:

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
```

Expected healthy database-backed response includes:

```json
{
  "ok": true,
  "persistent": true,
  "mode": "postgres"
}
```

### Render logs

- Dashboard: **Render service → Logs** for runtime logs.
- Deploy output: **Render service → Deploys → select the deploy**.
- CLI, if installed: `render logs --resources YOUR_SERVICE_ID --tail`

Search for:

- `Fatal startup error`
- `PostgreSQL initialization failed`
- `OpenRouter authentication failed`
- `rate limit`
- `upstream_timeout`
- `filesystem-fallback`

Never paste `OPENROUTER_API_KEY` or a database connection string into a public issue or log message.

## 7. Alternative free options

### Vercel Hobby

Vercel Hobby can host static assets and server-side functions with environment variables and streaming, but the current `server.mjs` is a long-running Node server, not a Vercel Function route. Deploying there would require an adapter that moves `/api/*` into Vercel Functions and moves static serving into the Vercel project. Hobby has function duration limits and is intended for personal, non-commercial use. It is not the lowest-change path for this repository.

### Cloudflare Pages + Workers

Cloudflare can host the static frontend on Pages and the backend as a Worker. Workers support streamed `ReadableStream` responses and server-side environment bindings. This requires a separate Worker implementation because the current server imports Node APIs (`node:http`, `node:fs`, `node:crypto`, and `pg`). Persistence would need D1, Durable Objects, or an external database. The free Workers plan has request, CPU, memory, and environment-variable limits, so it is a migration option rather than a drop-in deployment.

## 8. Features requiring external configuration or paid service

- Live model responses require an OpenRouter API key. Hosting can be free while inference is still paid or rate-limited.
- A durable database requires `DATABASE_URL`. Without it, local JSON files are ephemeral on Render.
- Authentication is not implemented. Do not expose this as a multi-user private workspace until authentication and authorization are added.
- Durable distributed rate limiting is not implemented. The current limiter is process-local and resets on restart.
- Backups, audit logs, billing controls, and team permissions are not implemented.
- Custom domains may be available on a free host, but domain registration itself is generally not free.
- More predictable latency, no cold starts, higher rate limits, backups, and multi-instance scaling may require paid hosting/database/OpenRouter plans.
