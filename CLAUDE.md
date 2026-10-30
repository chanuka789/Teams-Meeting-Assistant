# CLAUDE.md – notes for Claude Code sessions

## Project
Live meeting assistant. Browser captures meeting audio (getDisplayMedia system/tab audio), an energy VAD cuts speech into segments, server forwards each WAV segment to OpenRouter speech-to-text, then asks an OpenRouter chat model whether there is a question for the user and streams a short answer.

## Layout
- `server.js` – Express server, `/api/transcribe`, `/api/answer` (streams plain text), `/api/config`, `/health`, password check (`x-app-password` header vs `APP_PASSWORD`).
- `lib/prompt.js` – system prompt, message builder, hallucination filter. Answer format: `NONE` or `Q: …\nA: - …`.
- `public/audio.js` – VAD (`SpeechSegmenter`), resample, WAV encode. Pure, unit tested.
- `public/app.js` – UI, capture, pipeline. `public/capture-worklet.js` – AudioWorklet.
- `test/` – `npm test` (node:test).

## Conventions
- No build step, no frameworks. Plain ES modules.
- Never send the OpenRouter key to the browser.
- Keep answers short; never let the model invent figures not in notes/transcript.
- `OPENROUTER_BASE_URL` can point at a mock server for local tests.

## Deploy
Railway service builds with Railpack from `main` (config in `railway.json`). Secrets live in Railway variables.
