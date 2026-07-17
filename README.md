# Watch Later Backend

Hono API and future BullMQ worker for Watch Later.

## Local setup

1. Copy `.env.example` to `.env` and provide Clerk/TMDB credentials.
2. Run `docker compose up -d --build`.
3. Wait until `docker compose ps` reports the API as healthy.

The Compose stack runs PostgreSQL, Redis, MinIO, a one-shot database and bucket initializer, the Hono API on port 3000, the BullMQ identification worker, Loki, and Grafana. API and worker secrets come from `.env` and are not copied into the image. The local S3 API is available on port 9000 and the MinIO console at `http://localhost:9001` (`watch_later` / `watch_later_dev_secret`).

Durable local data is stored in `data/postgres`, `data/redis`, and `data/minio`. PostgreSQL uses a bind mount, Redis uses AOF with one-second fsync plus an initial snapshot, and MinIO persists the private `watch-later-media` bucket. The entire `data/` directory is ignored by Git. Worker processing files remain ephemeral; retained evidence is copied to S3.

For development without application containers, run `pnpm dev` and `pnpm worker:dev`. The worker requires `GEMINI_API_KEY`; `GEMINI_MODEL` defaults to `gemini-3.5-flash`.

For local UI development only, set `ALLOW_DEV_AUTH=true` and send `x-dev-user-id`. Production must keep it `false`.

## API documentation

The interactive Swagger UI is available at `http://localhost:3000/docs`. The OpenAPI 3.1 contract is available as JSON at `http://localhost:3000/openapi.json`. The contract documents every non-administrative endpoint; `/v1` operations accept a Clerk bearer token through Swagger's **Authorize** action.

## Logs and Grafana

API and worker operational logs remain structured JSON on stdout and in PostgreSQL. When `LOKI_URL` is configured, the same records are also sent to Loki with `component`, `environment`, `level`, and `service` labels. A Loki failure never interrupts the application request or job that produced the log.

The Compose stack exposes Loki at `http://localhost:3100` and Grafana at `http://localhost:3001`. The local Grafana credentials default to `admin` / `watch_later_dev_secret`; override them with `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` in `.env`. The Loki datasource and the **Watch Later — Logs** dashboard are provisioned automatically. Loki retains logs for seven days in the `loki-data` volume, while Grafana state is stored in `grafana-data`.

Railway runs Loki and Grafana as separate services with persistent volumes mounted at `/loki` and `/var/lib/grafana`. API and worker use the private endpoint `http://loki.railway.internal:3100/loki/api/v1/push`; only Grafana receives a public domain. The production Grafana password is stored as the `GF_SECURITY_ADMIN_PASSWORD` variable on its Railway service.

## Main API flow

All `/v1` routes require a Clerk bearer token.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/submissions` | Persist and enqueue a public Reel |
| `GET` | `/v1/inbox?before=&limit=` | Paginated processing Inbox with candidates and linked work |
| `GET` | `/v1/submissions/:id` | Submission detail, candidates, result, and canonical work |
| `POST` | `/v1/submissions/:id/confirm` | Confirm one of the stored catalog candidates |
| `POST` | `/v1/submissions/:id/resolve` | Resolve through catalog search or a private custom work |
| `POST` | `/v1/submissions/:id/reprocess` | Clear a terminal result and safely enqueue it again |
| `GET` | `/v1/catalog/works?q=&type=` | Manual TMDB search for movies or series |
| `GET` | `/v1/watchlist?before=&limit=` | Paginated watchlist |
| `GET` | `/v1/watchlist/:entryId` | Work detail and source-Reel history |
| `PATCH` | `/v1/watchlist/:entryId` | Set `want_to_watch`, `watching`, or `watched` |
| `DELETE` | `/v1/watchlist/:entryId` | Remove the user's entry without deleting canonical data |

Stable client errors include `invalid_reel_url`, `unsupported_url`, `invalid_candidate`, `candidate_not_allowed`, `submission_busy`, `submission_already_resolved`, `submission_not_found`, `watchlist_entry_not_found`, and `invalid_pagination`. Unexpected failures return only `internal_error`; detailed diagnostics remain in protected operational logs.

## Global cache and deduplication

- Valid results are cached anonymously by normalized Reel URL and pipeline version.
- Exact SHA-256 media matches reuse an identified work across reposted URLs without calling Gemini.
- Entries expire after `IDENTIFICATION_CACHE_TTL_DAYS` (180 by default) and renew on every hit.
- BullMQ coalesces concurrent submissions for the same normalized URL into one job; completion fans the result out to every waiting user.
- Manual corrections remain personal and never overwrite the global cache.
- Administrators can inspect `GET /v1/admin/cache` and invalidate an entry with `DELETE /v1/admin/cache/:cacheId`.

## Quotas and retries

- The default is 10 novel analyses per user per São Paulo calendar day and 3 user retries per URL/day.
- Global limits and per-Clerk-user overrides are stored in PostgreSQL and editable from the admin panel or `/v1/admin/quotas` APIs.
- Cache hits and repeated normalized URLs do not consume quota. Technical failures and exact-fingerprint cache hits refund a reservation.
- Excess submissions remain durable as `waiting_for_quota`; the API reconciler admits the oldest eligible entries every minute.
- Recoverable worker failures use at most three exponential-backoff attempts. Permanent failures stop after the first attempt.
