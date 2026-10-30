# Teams Meeting Assistant

A web app that listens to the **other people** in your Microsoft Teams meeting and shows short suggested answers on screen when someone asks you a question.

Tuned for **RICS APC final interviews** (Quantity Surveying and Construction pathway): answers are a short description plus 3-6 short points (including how I use it as a QS), experience questions use only your notes, technical and ethics answers follow current RICS standards, and the AI leaves out anything it is not sure of.

- Hears only the other side: it captures the meeting's audio output, not your microphone. With headphones on, your own voice is never in that audio.
- Speech-to-text and answers both go through **OpenRouter** (one API key).
- Your notes (project facts, cost plan figures, dates) are used to answer. The AI is told not to invent figures that are not in your notes.

## How to use

1. Open the app in **Chrome or Edge on Windows** and enter the app password.
2. Click **Notes & settings** and paste your meeting notes / project context.
3. Click **Start listening**.
   - **Teams desktop app:** choose the **Entire screen** tab and tick **Share system audio**.
   - **Teams in the browser:** choose the Teams **tab** and tick **Share tab audio**.
4. Keep the app open on a second screen or beside Teams. Answers appear on the left, the transcript on the right.
5. You can also type a question into the **Ask** box.

To test without a meeting, play a YouTube interview video in a Chrome tab and share that tab with **Share tab audio** ticked. The app never uses your microphone.

## How it works

```
Teams audio ─► browser (screen/tab share audio) ─► voice detection cuts speech at pauses
   ─► /api/transcribe ─► OpenRouter /audio/transcriptions (Whisper Large v3 Turbo)
   ─► transcript ─► /api/answer ─► OpenRouter chat (Claude Sonnet 5.5, streamed)
   ─► "NONE" (ignored) or "Q: … / A: …" card on screen
```

The server keeps the OpenRouter key secret; the browser never sees it.

## Choosing AI models

In **Notes & settings → AI models** you can pick any answer model and speech-to-text model from the live OpenRouter list, and the thinking level. Your choice is saved in your browser. The environment variables below are only the defaults.

## Your documents

In **Notes & settings → Your documents**, upload PDF, Word (.docx), TXT or Markdown files (max 20 MB each). The server only extracts the text; the text is stored in your browser (IndexedDB). For each question the app finds the most relevant passages (keyword search, BM25) and sends up to ~6,000 characters of them with the question. Answer cards show which documents were used (`from: …`). Scanned PDFs need OCR first.

## Question detection

Each piece of speech goes through: English-only filter (drops sound tags, silence hallucinations and non-Latin text) → filler check (mm-hmm, okay… skipped with no AI call) → fast detection model that joins split questions and fixes technical terms → answer model. Questions already answered are not answered again.

## Cost

- Model pickers show prices: answer models per 1M tokens, speech-to-text models per audio hour (or per 1M tokens).
- Each answer card shows what that answer cost. **Spent** in the top bar is the running total (speech-to-text + answers, including replies where no question was found). Details and **Reset counter** are in **Notes & settings → Cost**.
- Amounts are the real costs OpenRouter reports for each request (USD). The settings also show the total used on your OpenRouter key.

## Settings (environment variables)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | – | From https://openrouter.ai/keys |
| `APP_PASSWORD` | strongly recommended | – | Without it anyone with the URL can use your credits |
| `STT_MODEL` | no | `openai/whisper-large-v3-turbo` | Try `deepgram/nova-3` or `openai/gpt-4o-mini-transcribe` for accuracy |
| `ANSWER_MODEL` | no | `anthropic/claude-sonnet-5.5` | Any OpenRouter chat model. `anthropic/claude-haiku-5.5` is faster/cheaper, less accurate |
| `ANSWER_REASONING` | no | `low` | AI thinking level: `low`, `medium`, `high`. Higher = slower. `none` works only with Haiku |
| `DETECT_MODEL` | no | `anthropic/claude-haiku-5.5` | Fast model that decides if speech is a question (thinking off) |
| `STT_LANGUAGE` | no | `en` | `auto` to let the model detect |

## Run locally

```bash
cp .env.example .env   # fill in values
npm install
OPENROUTER_API_KEY=... APP_PASSWORD=... npm start
# open http://localhost:3000
npm test
```

## Deploy

Hosted on Railway. Pushing to `main` redeploys automatically. Health check: `/health`.

## Important

- Tell meeting participants that an AI assistant transcribes the call, and check your company's AI and data policy before using it with client meetings.
- AI answers can be wrong. Treat them as suggestions.
