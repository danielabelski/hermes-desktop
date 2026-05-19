import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { HERMES_HOME } from "./installer";
import { profilePaths, escapeRegex, safeWriteFile } from "./utils";

// ── Connection Config (local / remote / ssh) ─────────────

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  keyPath: string;
  remotePort: number;
  localPort: number;
}

export interface ConnectionConfig {
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
  apiKey: string;
  ssh: SshConnectionConfig;
}

export interface PublicConnectionConfig {
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
  hasApiKey: boolean;
  ssh: SshConnectionConfig;
}

// Lazy getter — avoids circular dependency with installer.ts
// (HERMES_HOME may not be assigned yet when this module first loads)
function desktopConfigFile(): string {
  return join(HERMES_HOME, "desktop.json");
}

export function readDesktopConfig(): Record<string, unknown> {
  try {
    const f = desktopConfigFile();
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf-8"));
  } catch {
    return {};
  }
}

export function writeDesktopConfig(data: Record<string, unknown>): void {
  if (!existsSync(HERMES_HOME)) {
    mkdirSync(HERMES_HOME, { recursive: true });
  }
  writeFileSync(desktopConfigFile(), JSON.stringify(data, null, 2), "utf-8");
}

export function getConnectionConfig(): ConnectionConfig {
  const data = readDesktopConfig();
  const ssh = (data.sshConfig as Partial<SshConnectionConfig>) ?? {};
  return {
    mode: (data.connectionMode as "local" | "remote" | "ssh") || "local",
    remoteUrl: (data.remoteUrl as string) || "",
    apiKey: (data.remoteApiKey as string) || "",
    ssh: {
      host: (ssh.host as string) || "",
      port: (ssh.port as number) || 22,
      username: (ssh.username as string) || "",
      keyPath: (ssh.keyPath as string) || "",
      remotePort: (ssh.remotePort as number) || 8642,
      localPort: (ssh.localPort as number) || 18642,
    },
  };
}

export function getPublicConnectionConfig(): PublicConnectionConfig {
  const config = getConnectionConfig();
  return {
    mode: config.mode,
    remoteUrl: config.remoteUrl,
    hasApiKey: config.apiKey.length > 0,
    ssh: config.ssh,
  };
}

export function setConnectionConfig(config: ConnectionConfig): void {
  const data = readDesktopConfig();
  data.connectionMode = config.mode;
  data.remoteUrl = config.remoteUrl;
  data.remoteApiKey = config.apiKey;
  if (config.mode === "ssh") {
    data.sshConfig = config.ssh;
  }
  writeDesktopConfig(data);
}

export function resolveConnectionApiKeyUpdate(
  existing: ConnectionConfig,
  mode: "local" | "remote" | "ssh",
  remoteUrl: string,
  apiKey?: string,
): string {
  if (apiKey !== undefined) return apiKey;
  if (existing.mode === mode && existing.remoteUrl === remoteUrl) {
    return existing.apiKey;
  }
  return "";
}

// ── In-memory cache with TTL ─────────────────────────────
const CACHE_TTL = 5000; // 5 seconds
const _cache = new Map<string, { data: unknown; ts: number }>();
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getCached<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  _cache.set(key, { data, ts: Date.now() });
}

function invalidateCache(prefix: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

export function readEnv(profile?: string): Record<string, string> {
  const cacheKey = `env:${profile || "default"}`;
  const cached = getCached<Record<string, string>>(cacheKey);
  if (cached) return cached;

  const { envFile } = profilePaths(profile);
  if (!existsSync(envFile)) return {};

  const content = readFileSync(envFile, "utf-8");
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const eqIndex = trimmed.indexOf("=");
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value) result[key] = value;
  }

  setCache(cacheKey, result);
  return result;
}

export function setEnvValue(
  key: string,
  value: string,
  profile?: string,
): void {
  validateEnvEntry(key, value);

  const { envFile } = profilePaths(profile);
  invalidateCache(`env:${profile || "default"}`);

  if (!existsSync(envFile)) {
    safeWriteFile(envFile, `${key}=${value}\n`);
    return;
  }

  const content = readFileSync(envFile, "utf-8");
  const lines = content.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(new RegExp(`^#?\\s*${escapeRegex(key)}\\s*=`))) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(`${key}=${value}`);
  }

  safeWriteFile(envFile, lines.join("\n"));
}

export function validateEnvEntry(key: string, value: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      "Invalid environment variable name. Use letters, numbers, and underscores, and do not start with a number.",
    );
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error("Environment variable values must be single-line strings.");
  }
}

export function getConfigValue(key: string, profile?: string): string | null {
  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) return null;

  const content = readFileSync(configFile, "utf-8");
  const regex = new RegExp(
    `^\\s*${escapeRegex(key)}:\\s*["']?([^"'\\n#]+)["']?`,
    "m",
  );
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

export function setConfigValue(
  key: string,
  value: string,
  profile?: string,
): void {
  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) return;

  let content = readFileSync(configFile, "utf-8");
  const regex = new RegExp(
    `^(\\s*#?\\s*${escapeRegex(key)}:\\s*)["']?[^"'\\n#]*["']?`,
    "m",
  );

  if (regex.test(content)) {
    content = content.replace(regex, `$1"${value}"`);
  }

  safeWriteFile(configFile, content);
}

export function getModelConfig(profile?: string): {
  provider: string;
  model: string;
  baseUrl: string;
} {
  const cacheKey = `mc:${profile || "default"}`;
  const cached = getCached<{
    provider: string;
    model: string;
    baseUrl: string;
  }>(cacheKey);
  if (cached) return cached;

  const { configFile } = profilePaths(profile);
  const defaults = { provider: "auto", model: "", baseUrl: "" };
  if (!existsSync(configFile)) return defaults;

  const content = readFileSync(configFile, "utf-8");

  const providerMatch = content.match(/^\s*provider:\s*["']?([^"'\n#]+)["']?/m);
  const modelMatch = content.match(/^\s*default:\s*["']?([^"'\n#]+)["']?/m);
  const baseUrlMatch = content.match(/^\s*base_url:\s*["']?([^"'\n#]+)["']?/m);

  const result = {
    provider: providerMatch ? providerMatch[1].trim() : defaults.provider,
    model: modelMatch ? modelMatch[1].trim() : defaults.model,
    baseUrl: baseUrlMatch ? baseUrlMatch[1].trim() : defaults.baseUrl,
  };

  setCache(cacheKey, result);
  return result;
}

export function setModelConfig(
  provider: string,
  model: string,
  baseUrl: string,
  profile?: string,
): void {
  invalidateCache(`mc:${profile || "default"}`);
  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) return;

  let content = readFileSync(configFile, "utf-8");

  const providerRegex = /^(\s*provider:\s*)["']?[^"'\n#]*["']?/m;
  if (providerRegex.test(content)) {
    content = content.replace(providerRegex, `$1"${provider}"`);
  }

  const modelRegex = /^(\s*default:\s*)["']?[^"'\n#]*["']?/m;
  if (modelRegex.test(content)) {
    content = content.replace(modelRegex, `$1"${model}"`);
  }

  const baseUrlRegex = /^(\s*base_url:\s*)["']?[^"'\n#]*["']?/m;
  if (baseUrlRegex.test(content)) {
    content = content.replace(baseUrlRegex, `$1"${baseUrl}"`);
  } else if (baseUrl && provider !== "auto") {
    // Append base_url line after the provider line in the model section
    content = content.replace(
      /^(\s*provider:\s*"[^"]*"\s*\n)/m,
      `$1  base_url: "${baseUrl}"\n`,
    );
  }

  // Disable smart_model_routing
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (
      /^\s*enabled:\s*(true|false)/.test(lines[i]) &&
      i > 0 &&
      /smart_model_routing/.test(lines[i - 1])
    ) {
      lines[i] = lines[i].replace(/(enabled:\s*)(true|false)/, "$1false");
    }
  }
  content = lines.join("\n");

  // Enable streaming
  const streamingRegex = /^(\s*streaming:\s*)(\S+)/m;
  if (streamingRegex.test(content)) {
    content = content.replace(streamingRegex, "$1true");
  }

  safeWriteFile(configFile, content);
}

export function getHermesHome(profile?: string): string {
  return profilePaths(profile).home;
}

// ── Platform enabled/disabled ─────────────────────────────
//
// The Python hermes gateway (gateway/config.py) decides which messaging
// platforms to start from env vars in .env; it doesn't look at a fictional
// `platforms:` YAML section. config.yaml only carries an override-disable
// switch: `<platform>.enabled: false` at the top level. Earlier the desktop
// read and wrote a `platforms:\n  <name>:\n    enabled: …` block that the
// gateway never inspected, so the Gateway UI's toggles were cosmetic.
//
// `envCheck` returns true when the platform's required env vars are present
// (and, for whatsapp, set to a truthy literal). Add new platforms here as
// their Python-side activation rules are confirmed.
interface PlatformRule {
  envCheck: (env: Record<string, string>) => boolean;
  // YAML key for the override-disable lookup. Defaults to the platform key
  // itself; provide an explicit value when the desktop's display key
  // diverges from the Python CLI's config.yaml key (e.g. "home_assistant"
  // in the desktop vs "homeassistant" in the Python gateway).
  configKey?: string;
}

const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

const PLATFORM_RULES: Record<string, PlatformRule> = {
  telegram: { envCheck: (e) => !!e.TELEGRAM_BOT_TOKEN?.trim() },
  discord: { envCheck: (e) => !!e.DISCORD_BOT_TOKEN?.trim() },
  slack: { envCheck: (e) => !!e.SLACK_BOT_TOKEN?.trim() },
  whatsapp: {
    envCheck: (e) =>
      TRUTHY_VALUES.has((e.WHATSAPP_ENABLED || "").trim().toLowerCase()),
  },
  signal: {
    envCheck: (e) => !!e.SIGNAL_HTTP_URL?.trim() && !!e.SIGNAL_ACCOUNT?.trim(),
  },
  matrix: {
    envCheck: (e) =>
      !!e.MATRIX_ACCESS_TOKEN?.trim() || !!e.MATRIX_PASSWORD?.trim(),
  },
  mattermost: { envCheck: (e) => !!e.MATTERMOST_TOKEN?.trim() },
  home_assistant: {
    envCheck: (e) => !!e.HASS_TOKEN?.trim(),
    configKey: "homeassistant",
  },
};

const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_RULES);

/**
 * Match a top-level YAML block's `enabled: <bool>` field, e.g.:
 *
 *     telegram:
 *       reactions: false
 *       enabled: false      ← captured
 *       allowed_chats: ''
 *
 * Returns true/false if found, null if absent. The block must start at
 * column 0; `enabled:` is captured if it sits anywhere inside the
 * contiguous indented sub-block (any depth, in any position).
 */
function readPlatformOverride(
  content: string,
  platform: string,
): boolean | null {
  const blockStartRe = new RegExp(`^${escapeRegex(platform)}:[ \\t]*\\r?\\n`, "m");
  const startMatch = content.match(blockStartRe);
  if (!startMatch || startMatch.index === undefined) return null;

  const after = content.slice(startMatch.index + startMatch[0].length);
  const lines = after.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // hit next top-level key
    const m = line.match(/^[ \t]+enabled:[ \t]*(true|false)\b/);
    if (m) return m[1] === "true";
  }
  return null;
}

export function getPlatformEnabled(profile?: string): Record<string, boolean> {
  const env = readEnv(profile);
  const { configFile } = profilePaths(profile);
  const content = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";

  const result: Record<string, boolean> = {};
  for (const platform of SUPPORTED_PLATFORMS) {
    const rule = PLATFORM_RULES[platform];
    const envEnabled = rule.envCheck(env);
    const configKey = rule.configKey || platform;
    const override = content ? readPlatformOverride(content, configKey) : null;
    // Python's rule: env-driven activation, config.yaml `enabled: false`
    // can force-disable. An explicit `enabled: true` doesn't bypass a
    // missing token (the Python gateway still requires the credential),
    // so reflect that here too.
    result[platform] = envEnabled && override !== false;
  }
  return result;
}

/**
 * Toggle a platform's force-disable override in config.yaml.
 *
 * The Python gateway activates a platform when its env vars are set;
 * config can force-disable with `<platform>.enabled: false` at the top
 * level. So toggling here writes/removes that single key:
 *
 *   - enabled=false → ensure `enabled: false` exists in the top-level
 *     `<platform>:` block (modify in place, append a child, or create
 *     the block).
 *   - enabled=true  → remove any existing `enabled: false` line.
 *
 * Filling in the platform's token env vars is what actually starts it;
 * this function only manages the disable override.
 */
export function setPlatformEnabled(
  platform: string,
  enabled: boolean,
  profile?: string,
): void {
  const rule = PLATFORM_RULES[platform];
  if (!rule) return;
  // Use the Python-side YAML key when writing the override, not the
  // desktop's display key (matters for home_assistant → homeassistant).
  const configKey = rule.configKey || platform;

  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) {
    // Only need to write a file when we're recording a disable override;
    // enabling a platform that has no config is the default.
    if (enabled) return;
    safeWriteFile(configFile, `${configKey}:\n  enabled: false\n`);
    return;
  }

  let content = readFileSync(configFile, "utf-8");
  const enabledLineRe = new RegExp(
    `^([ \\t]+enabled:[ \\t]*)(true|false)\\b([ \\t]*)$`,
    "m",
  );
  const blockStartRe = new RegExp(
    `^(${escapeRegex(configKey)}:[ \\t]*\\r?\\n)`,
    "m",
  );
  const flowStyleRe = new RegExp(
    `^${escapeRegex(configKey)}:[ \\t]*\\{\\s*\\}[ \\t]*$`,
    "m",
  );

  const blockMatch = content.match(blockStartRe);
  const hasBlock = !!blockMatch;
  const isFlowEmpty = flowStyleRe.test(content);

  if (isFlowEmpty) {
    // Convert `<platform>: {}` to a block we can edit.
    content = content.replace(flowStyleRe, `${configKey}:\n  enabled: ${enabled}`);
    safeWriteFile(configFile, content);
    return;
  }

  if (hasBlock && blockMatch?.index !== undefined) {
    const blockStart = blockMatch.index + blockMatch[0].length;
    const rest = content.slice(blockStart);
    const restLines = rest.split(/\r?\n/);

    // Find the extent of the platform's sub-block (indented children).
    let subBlockEndOffset = 0;
    let existingEnabledLineStart: number | null = null;
    let existingEnabledLineEnd: number | null = null;
    for (const line of restLines) {
      const lineLen = line.length + 1; // include trailing \n
      if (line.trim() === "") {
        subBlockEndOffset += lineLen;
        continue;
      }
      if (!/^\s/.test(line)) break;
      const localStart = blockStart + subBlockEndOffset;
      const enabledMatch = line.match(enabledLineRe);
      if (enabledMatch) {
        existingEnabledLineStart = localStart;
        existingEnabledLineEnd = localStart + line.length;
      }
      subBlockEndOffset += lineLen;
    }

    if (existingEnabledLineStart !== null && existingEnabledLineEnd !== null) {
      if (enabled) {
        // Remove the entire `  enabled: false` line, including its newline.
        const removeEnd =
          content[existingEnabledLineEnd] === "\n"
            ? existingEnabledLineEnd + 1
            : existingEnabledLineEnd;
        content =
          content.slice(0, existingEnabledLineStart) + content.slice(removeEnd);
      } else {
        content =
          content.slice(0, existingEnabledLineStart) +
          `  enabled: false` +
          content.slice(existingEnabledLineEnd);
      }
    } else if (!enabled) {
      // Append `enabled: false` as the first child of the block.
      content =
        content.slice(0, blockStart) +
        `  enabled: false\n` +
        content.slice(blockStart);
    }
    // (enabled=true with no existing override: nothing to do.)

    safeWriteFile(configFile, content);
    return;
  }

  // No block at all — only need to materialize one when recording a disable.
  if (!enabled) {
    const trailingNewline = content.endsWith("\n") ? "" : "\n";
    content += `${trailingNewline}${configKey}:\n  enabled: false\n`;
    safeWriteFile(configFile, content);
  }
}

// ── Credential Pool (auth.json) ──────────────────────────

function authFilePath(): string {
  return join(HERMES_HOME, "auth.json");
}

interface CredentialEntry {
  key: string;
  label: string;
}

function readAuthStore(): Record<string, unknown> {
  try {
    const p = authFilePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeAuthStore(store: Record<string, unknown>): void {
  safeWriteFile(authFilePath(), JSON.stringify(store, null, 2));
}

export function getCredentialPool(): Record<string, CredentialEntry[]> {
  const store = readAuthStore();
  const pool = store.credential_pool;
  if (!pool || typeof pool !== "object") return {};
  return pool as Record<string, CredentialEntry[]>;
}

export function setCredentialPool(
  provider: string,
  entries: CredentialEntry[],
): void {
  const store = readAuthStore();
  if (!store.credential_pool || typeof store.credential_pool !== "object") {
    store.credential_pool = {};
  }
  (store.credential_pool as Record<string, CredentialEntry[]>)[provider] =
    entries;
  writeAuthStore(store);
}
