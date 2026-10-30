# APC Interview Assistant

A web app for RICS APC final interviews (Quantity surveying and construction pathway). It listens to the **assessors** in your Microsoft Teams meeting, detects each question and shows an answer in the style you choose (points only, short description only, description + 3–4 points, or detailed), using a shared **competency library** and your own private **case study**.

- Hears only the other side: it captures the meeting's audio output (screen or tab share), never your microphone. Wear headphones.
- English only. Filler ("mm-hmm", "okay") and noise are dropped before any AI call.
- Speech-to-text, question detection and answers all go through **OpenRouter** (one API key, kept on the server).
- Light and dark mode, separate text sizes for answers and transcript, works on desktop and phone.

## Pages

| Page | Who | What |
|---|---|---|
| Live interview | everyone | Start/stop listening, live transcript, answer cards with sources, type a question, text size controls, compact **model / thinking / answer style** dropdowns above the answers, **Float answers**: an always-on-top window (Chrome/Edge) that shows the latest answer like a subtitle and can be dragged over the Teams window |
| Chat | everyone | Study chat with saved, searchable conversations. Answers use the library and your case study and cite them ([1], [2]); click a citation or source to open the document beside the chat, scrolled to the passage and briefly highlighted (a list when several places were used). Choose model, thinking, which documents to search and answer length; stop, regenerate, copy, export |
| Competency library | everyone reads, admins upload | Documents organised by the 19 QS&C competencies (11 mandatory, 6 core, optional list) plus General RICS guidance; admins can edit the list |
| My case study | each user | Private case study documents (report, slides with speaker notes, figures); nobody else can open them |
| Settings | each user | Profile and notes, theme, text sizes, AI models with prices, usage and cost, password |
| Users | admins | Add users, reset passwords, change roles, see spend per user |

Supported files: PDF, Word (.docx), PowerPoint (.pptx, including speaker notes), TXT, Markdown, CSV, up to 50 MB. Old .doc / .ppt must be saved as .docx / .pptx first. Scanned PDFs need OCR.

## How it works

```
Teams audio ─► browser (screen/tab share) ─► voice detection cuts speech at pauses
  ─► /api/transcribe (OpenRouter speech-to-text, English, filters noise)
  ─► /api/detect (fast model joins split questions, skips filler and repeats)
  ─► /api/answer: Postgres full-text search over the library + the user's case study
       ─► answer model (streamed) ─► answer card with source badges
```

Storage: original files in a **Railway bucket** (S3-compatible); users, sessions, document text (searchable chunks) and usage in **Railway Postgres**.

## First run

Open the app. Because no users exist yet, it shows **Set up your app**: enter your name, a username, a password and the **setup key** (the `APP_PASSWORD` value in Railway). That creates the first admin. Add other users on the **Users** page.

## Settings (environment variables)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | – | From https://openrouter.ai/keys |
| `DATABASE_URL` | yes | – | Railway: `${{Postgres.DATABASE_URL}}` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes on Railway | – | Bucket reference variables. Without `S3_BUCKET` files go to `./data/uploads` (local development) |
| `APP_PASSWORD` | recommended | – | Setup key for creating the first admin |
| `ANSWER_MODEL` | no | `anthropic/claude-sonnet-5.5` | Default; each user can choose in Settings |
| `ANSWER_REASONING` | no | `low` | Default thinking level |
| `DETECT_MODEL` | no | `anthropic/claude-haiku-5.5` | Question detection (thinking off) |
| `STT_MODEL` | no | `openai/whisper-large-v3-turbo` | Speech-to-text |
| `STT_LANGUAGE` | no | `en` | |

## Run locally

```bash
npm install
# Postgres running locally, e.g. postgres://postgres@localhost:5432/tma
DATABASE_URL=postgres://... OPENROUTER_API_KEY=... APP_PASSWORD=... npm start
# open http://localhost:3000
npm test
```

## Deploy

Railway project `teams-meeting-assistant`: services `web` (this repo), `Postgres`, and bucket `documents`. Pushing to the connected branch redeploys. `/health` reports database and storage status.

## Important

- Tell the assessors that an AI assistant transcribes the call, and check that RICS assessment rules allow it.
- AI answers can be wrong. Treat them as suggestions.
