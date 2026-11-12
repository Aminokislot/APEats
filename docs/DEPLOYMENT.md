# Deployment

The app is one Node.js 22 process: static files plus a JSON API, no build step, one runtime dependency. Any host that
runs Node or the repository `Dockerfile` works. The options below are instructions; they have not been tested on a
specific provider.

| | Gemini API | Gemini Enterprise |
|---|---|---|
| Setting | `AI_PROVIDER=gemini` + rules fallback | `AI_PROVIDER=enterprise` + the same fallback |
| Needs | A Gemini API key | Access to a Gemini Enterprise app and a registered agent |
| Label in the app | "Gemini" / "Rules-based" | "Gemini Enterprise agent", only after a real agent has answered |

## Settings

```dotenv
AI_PROVIDER=gemini
GEMINI_MODEL=              # optional; default in lib/gemini.js
VOTE_STORAGE=local         # or firestore, see below
TRUST_PROXY=true           # behind a host's proxy, so rate limits count per visitor, not per proxy
# GEMINI_API_KEY comes from the host's secret store, never from the repository or the image
```

`.env`, `data/votes.json`, backups and credentials are excluded by `.gitignore` and `.dockerignore`. User preferences
live only in each visitor's browser. On a free API tier, busy models answer with 429/503 and the app then shows the
labelled rules-based fallback.

## Option 1: a Node or Docker host

Connect the repository, start command `node server.js` (or build the `Dockerfile`), set the variables above, add
`GEMINI_API_KEY` as a secret. The service listens on `PORT`. With `VOTE_STORAGE=local` the optional cuisine poll is
kept in a file on the instance, so votes are lost when the instance restarts; the lunch finder, menu and Ask do not
use it.

## Option 2: Google Cloud Run

On Cloud Run the server refuses to start with local vote storage (`K_SERVICE` is set), so Firestore is required:

- a project with billing, Cloud Run and Cloud Build enabled, and permission to deploy;
- a Firestore Native database (`(default)` unless `FIRESTORE_DATABASE` is set);
- a service account for the service with `roles/datastore.user`;
- the API key in Secret Manager, exposed to the service as `GEMINI_API_KEY`.

```powershell
gcloud run deploy apeats --source . --project YOUR_PROJECT_ID --region asia-southeast1 `
  --service-account APEATS_SERVICE_ACCOUNT_EMAIL --allow-unauthenticated `
  --set-env-vars AI_PROVIDER=gemini,VOTE_STORAGE=firestore,TRUST_PROXY=true `
  --set-secrets GEMINI_API_KEY=apeats-gemini-key:latest
```

`--allow-unauthenticated` makes the service public; anyone with the link can then spend the key's quota within the
built-in rate limits (20 lunch searches and 12 questions per minute per client).

## Checks after deploying

1. `GET /api/status`: `provider` is `gemini`, `gemini` is `true`, the menu version is the expected one.
2. Run **Find my lunch** (RM10, Not spicy, Main dish + drink): the banner says "Chosen by Gemini…"; totals are right.
3. **Show another**, **Ask about it**, "Which drink was included, and how much is the whole set?".
4. Change a preference in **Me** and return to Lunch: results are marked outdated; **Update results** works.
5. Open the link on a phone and in a private window (no saved state).
6. Read the service log once: no key, no stack trace, no personal data.

## Gemini Enterprise

Needs, in addition to the above: access to a Gemini Enterprise app, an agent created there with the menu connected as
its source, its project/app/agent IDs, and a service identity allowed to call it. Steps and live acceptance checks:
[enterprise/SETUP.md](enterprise/SETUP.md).

```dotenv
AI_PROVIDER=enterprise
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
ENTERPRISE_APP_ID=YOUR_APP_ID
ENTERPRISE_AGENT_ID=YOUR_AGENT_ID
ENTERPRISE_LOCATION=global
```

The server uses Application Default Credentials: on Cloud Run attach the service account as the service identity and
do not upload a key file. Setting these variables proves nothing by itself: the integration counts as working only when
`POST /api/lunch` and `POST /api/ask` have answered with `source: enterprise` on the deployed service.

## Known limits

Rate limits are per process. The poll does not verify student identity. The Firestore poll summary reads every voter
document on each refresh, which suits a small demo only.
