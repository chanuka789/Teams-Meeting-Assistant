# Teams Meeting Assistant

A web app that listens to the **other people** in your Microsoft Teams meeting and shows short suggested answers on screen when someone asks you a question.

Tuned for **RICS APC final interviews** (Quantity Surveying and Construction pathway): answers are 2-4 short points, experience questions use only your notes, technical and ethics answers follow current RICS standards, and the AI leaves out anything it is not sure of.

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

## Settings (environment variables)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | – | From https://openrouter.ai/keys |
| `APP_PASSWORD` | strongly recommended | – | Without it anyone with the URL can use your credits |
| `STT_MODEL` | no | `openai/whisper-large-v3-turbo` | Try `deepgram/nova-3` or `openai/gpt-4o-mini-transcribe` for accuracy |
| `ANSWER_MODEL` | no | `anthropic/claude-sonnet-5.5` | Any OpenRouter chat model. `anthropic/claude-haiku-5.5` is faster/cheaper, less accurate |
| `ANSWER_REASONING` | no | `low` | AI thinking level: `low`, `medium`, `high`. Higher = slower. `none` works only with Haiku |
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
