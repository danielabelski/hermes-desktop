# Session model override

The in-chat (bottom) model picker selects a model for the **current conversation only** — it never rewrites `config.yaml`, so the Settings global default is preserved (#688), and carries the full model identity so cross-provider switches route correctly.

The override is held in renderer state on each `<Chat>` run ([[src/renderer/src/screens/Chat/Chat.tsx]]) and sent with every message; it is cleared when the conversation is cleared/reset and is absent on a fresh chat, so new conversations start on the global default. This is distinct from the persisted [[model-context]] default that non-chat surfaces read.

## Full identity, not just the model name

The override is a `SessionModelOverride` (`{provider, model, baseUrl}`), not a bare model string — because switching across providers must change routing, not only the `model` field.

The picker builds it via [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#effectiveOverrideBaseUrl]], the same baseUrl rule `selectModel` applies (keep the URL only for `custom`/`ollama-cloud`; clear it for named providers that have a canonical base URL), so the session pick and a persisted save can't drift. It is threaded renderer → preload IPC → main `sendMessage` as `modelOverride`.

## Cross-provider switch routes via CLI

A session override that changes the provider or base URL away from `config.yaml` is sent through the **CLI transport**, the only path that can be parameterized per call.

The gateway/API transport resolves the provider server-side from `config.yaml` — the request body carries only `model` — so it cannot honour a per-request provider change (a Gemini model id routed through a sticky `openai-codex` default is ignored, reporting the old model). [[src/main/hermes.ts#sendMessage]] computes an effective config (persisted config overlaid with the override) and routes to `sendMessageViaCli` when the override changes provider/baseUrl, passing `-m <model>` and an explicit `--provider`. Same-provider model swaps stay on the gateway/API path, where the new `model` string is sufficient. Remote (SSH) mode has no CLI transport, so it remains limited to the model string.
