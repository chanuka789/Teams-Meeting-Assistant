# CLAUDE.md – notes for Claude Code sessions

## Project
Live meeting assistant. Browser captures meeting audio (getDisplayMedia system/tab audio), an energy VAD cuts speech into segments, server forwards each WAV segment to OpenRouter speech-to-text, then asks an OpenRouter chat model whether there is a question for the user and streams a short answer.

## Layout
- `server.js` – Express server, `/api/transcribe`, `/api/answer` (streams plain text), `/api/config`, `/health`, password check (`x-app-password` header vs `APP_PASSWORD`).
- `public/models.js` – OpenRouter model list helpers (shared by server and browser, unit tested). `/api/models` serves the live lists (cached 1 h); requests may pass `model` / `reasoning`, validated against the list.
- `lib/prompt.js` – system prompt, message builder, hallucination filter. Answer format: `NONE` or `Q: …\nA:\n<one sentence per line>` (definition → key facts → main points → "In my role as a QS…" → closing; 7-10 lines, example answer in the prompt). Prompt is tuned for RICS APC final interviews (QS & Construction pathway).
- `public/audio.js` – VAD (`SpeechSegmenter`), resample, WAV encode. Pure, unit tested.
- `public/app.js` – UI, capture, pipeline. `public/capture-worklet.js` – AudioWorklet.
- `test/` – `npm test` (node:test).

## Conventions
- No build step, no frameworks. Plain ES modules.
- Never send the OpenRouter key to the browser.
- Keep answers to the set structure in the prompt (no padding); never let the model invent figures not in notes/transcript.
- `OPENROUTER_BASE_URL` can point at a mock server for local tests.
- Claude Sonnet 5.5 on OpenRouter always reasons (effort `none` is rejected) and reasoning tokens count toward `max_tokens`. A small `max_tokens` gives an empty answer, so keep it large and keep answers short through the prompt. Effort is set with `ANSWER_REASONING`.

## Deploy
Railway service builds with Railpack from `main` (config in `railway.json`). Secrets live in Railway variables.
