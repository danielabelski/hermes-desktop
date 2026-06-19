/**
 * A session-scoped model selection made from the in-chat (bottom) model
 * picker. Unlike the persisted `config.yaml` default, this override applies to
 * a single conversation only and is threaded through the send pipeline on every
 * message (renderer → preload IPC → main `sendMessage`).
 *
 * It carries the *full* model identity — not just the model name — because a
 * cross-provider switch (e.g. an OpenAI-Codex default → Gemini) must change the
 * provider and base URL that the request routes through, not only the `model`
 * string. The gateway/API transport resolves the provider server-side from
 * `config.yaml`, so an override that changes `provider`/`baseUrl` is routed
 * through the CLI transport, which can be parameterized per call.
 */
export interface SessionModelOverride {
  provider: string;
  model: string;
  baseUrl: string;
}
