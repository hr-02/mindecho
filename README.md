# MindEcho

A memory-aware journal. Every entry is read alongside a summary of your past
entries, so Gemini can notice real patterns instead of treating every session
like a stranger. Includes a **Brain Dump** mode for turning an overwhelming
stream of thoughts into one small next step, and a **Trust Circle** feature
for sharing a paraphrased, expiring, revocable recap with someone you choose.

Built on: **Firebase Authentication**, **Cloud Firestore** (per-user
isolated), **Secret Manager** (for the Gemini API key), the **Gemini API**,
and deployed on **Cloud Run**.

## How the requirements map to this code

| Requirement | Where it lives |
|---|---|
| User sign-in via Firebase Auth | `public/app.js` (client), `server.js` `requireAuth` (server verifies the ID token) |
| Multi-turn journaling with Gemini | `src/gemini.js` |
| Firestore, private per user, zero cross-user leakage | `users/{uid}/entries/*` — enforced by the API (`req.uid` scoping) **and** by `firebase/firestore.rules` as a backstop |
| API keys never hardcoded | `src/secrets.js` reads from Secret Manager in production |

**A deliberate design choice:** the browser never talks to Firestore
directly — it only calls this Express API, which verifies the Firebase ID
token and then uses the Admin SDK. That gives you two independent layers of
protection instead of one: the API only ever queries `users/{req.uid}/...`,
and the Firestore rules deny direct client access entirely as a backstop.
It also means the `shares` collection (used for the Trust Circle feature)
never needs to be exposed to any client SDK — only this server can read or
write it.

---

## 1. Prerequisites

- Node.js 20+
- A Google Cloud project with billing enabled
- The `gcloud` CLI, authenticated: `gcloud auth login`
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## 2. Set up Firebase

1. Go to the [Firebase Console](https://console.firebase.google.com) and
   either create a new project or add Firebase to your existing GCP project.
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Firestore Database** → create a database (Native mode, any region).
4. **Project settings** → **General** → scroll to "Your apps" → add a **Web
   app**. Copy the config object it gives you into
   `public/firebase-config.js`.
5. For local development only: **Project settings** → **Service accounts**
   → **Generate new private key**. Save it as `service-account.json` in the
   project root (it's already gitignored) and set
   `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` in your `.env`.

## 3. Deploy Firestore security rules

```bash
npm install -g firebase-tools   # if you don't have it
firebase login
cd firebase
firebase use --add               # pick your Firebase project
firebase deploy --only firestore:rules,firestore:indexes
```

## 4. Store your Gemini API key in Secret Manager

Do this once per project — never put the real key in code, `.env` files you
commit, or Cloud Run's plaintext environment variables.

```bash
gcloud config set project YOUR_PROJECT_ID

gcloud services enable secretmanager.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com

echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create gemini-api-key \
  --data-file=- --replication-policy=automatic
```

If the secret already exists and you're rotating the key:

```bash
echo -n "YOUR_NEW_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
```

## 5. Run it locally

```bash
npm install
cp .env.example .env
# edit .env: set GOOGLE_CLOUD_PROJECT, and for a local shortcut set
# GEMINI_API_KEY directly (skip Secret Manager while developing)
npm run dev
```

Open http://localhost:8080.

## 6. Deploy to Cloud Run

Cloud Run needs permission to read your secret. Find the service's runtime
service account first (the default is
`PROJECT_NUMBER-compute@developer.gserviceaccount.com` unless you've set a
custom one), then grant it access:

```bash
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

The same runtime service account also needs Firestore and Firebase Auth
access — grant it these two roles if it doesn't already have them:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/firebaseauth.admin"
```

Now build and deploy:

```bash
gcloud run deploy mindecho \
  --source . \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GEMINI_SECRET_NAME=gemini-api-key
```

`--allow-unauthenticated` is required here because real end users (not just
you) need to reach the app and its own Firebase-based login — Cloud Run's
own IAM auth is a separate layer you don't want in front of a public web app.

When it finishes, `gcloud` prints your service URL. Open it, sign up, and
write your first entry.

> **Check your program's actual instructions before deploying.** If your
> hackathon or challenge specifies a required region or a required resource
> label for automated scoring, follow those exactly — add
> `--labels=key=value` to the command above if one is required. Don't take
> a specific region or label as fixed unless your own program materials say
> so.

## 7. Before you submit

- [ ] Confirm the deployed Cloud Run URL actually loads and lets you sign
      up, write an entry, and see a Gemini response.
- [ ] Push this repo to a **public** GitHub/GitLab repository, including
      `firebase/firestore.rules` and this README, but double-check `.env`
      and `service-account.json` were never committed (`.gitignore` already
      excludes them).
- [ ] Write your own one-paragraph "why I built this" — the thing AI is
      worst at supplying convincingly on your behalf.
- [ ] Post publicly with your program's required hashtag, and include the
      link to your public repo in that post.
- [ ] Fill in every mandatory field on your program's submission dashboard.

## Project structure

```
mindecho/
├── server.js                 Express app + all API routes
├── src/
│   ├── firebaseAdmin.js      Firebase Admin SDK init
│   ├── secrets.js            Secret Manager lookup for the Gemini key
│   └── gemini.js             All Gemini calls + system instructions + schemas
├── public/
│   ├── index.html            Main app UI
│   ├── styles.css
│   ├── app.js                Auth, journaling, trust-circle client logic
│   ├── firebase-config.js    ← paste your Firebase web config here
│   ├── share.html            Public, unauthenticated share-link view
│   └── share.js
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   └── firebase.json
├── Dockerfile
├── .env.example
└── package.json
```

## Extending it further

A few directions that go beyond the baseline without touching Maps pins or
Slack webhooks (the two examples given in the program's own walkthrough
video — worth avoiding if you want your submission to look distinct rather
than cloned):

- A **quick-capture / brain-dump entry point** that feeds into the same
  memory-aware timeline as regular reflections (partially built already —
  Brain Dump mode currently doesn't feed into the memory context; consider
  whether it should).
- **Weekly digest**: reuse `summarizeForShare()`'s pattern to generate a
  private (not shared) weekly recap the user sees themselves.
- **Export**: let a user download all their own entries as JSON or Markdown
  — good-faith data portability, and an easy, low-risk feature to add.

Every time you add a feature that touches Gemini, update the relevant
system instruction in `src/gemini.js` first, so output quality and safety
constraints don't drift as the app grows.
