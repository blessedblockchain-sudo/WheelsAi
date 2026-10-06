import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import Conf from "conf";

import { CliError } from "./errors.js";
import { DEFAULT_API_URL, deriveWebUrl, parseBaseUrl, sameOrigin } from "./lib/urls.js";

export interface StoredConfig {
  /** Empty means "never set": the local development default is shown, and login asks for a URL. */
  apiUrl: string;
  /** Empty means "derive from apiUrl". */
  webUrl: string;
  /** Session token from `login --email`. */
  token: string;
  /** API key from `login`. */
  apiKey: string;
  /** The API URL the saved credential was issued for. It is sent to that server and no other. */
  credentialUrl: string;
}

/** Where settings are kept. The file-backed one is the default; tests pass one in memory. */
export interface ConfigStore {
  readonly path: string;
  get(key: keyof StoredConfig): string;
  set(values: Partial<StoredConfig>): void;
}

export type ConfigKey = "apiUrl" | "webUrl";
export const CONFIG_KEYS: readonly ConfigKey[] = ["apiUrl", "webUrl"];

const DEFAULTS: StoredConfig = { apiUrl: "", webUrl: "", token: "", apiKey: "", credentialUrl: "" };

/**
 * The per-user config directory (the same place `conf` picks for the project name `wheelsai`),
 * worked out here so it can be created private before anything is written into it.
 * `WHEELSAI_CONFIG_DIR` overrides it.
 */
export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.WHEELSAI_CONFIG_DIR?.trim()) return path.resolve(env.WHEELSAI_CONFIG_DIR.trim());
  const name = "wheelsai-nodejs";
  if (platform === "darwin") return path.join(home, "Library", "Preferences", name);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), name, "Config");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), name);
}

/** Remove any permission bits beyond `mode` (group and other access). A missing path is fine. */
function tighten(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(target).mode & 0o777 & ~mode) !== 0) chmodSync(target, mode);
  } catch {
    // Not there yet, or not ours to change: the write below reports any real problem.
  }
}

/**
 * Open the config file in `directory`. Credentials live in it, so the directory is kept at
 * 0700 and the file at 0600, re-applied on every open and write: `conf` only sets the file
 * mode on its atomic write path, and never the directory's.
 */
export function openFileStore(directory: string): ConfigStore {
  const file = path.join(directory, "config.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  tighten(directory, 0o700);
  tighten(file, 0o600);

  let conf: Conf<StoredConfig>;
  try {
    conf = new Conf<StoredConfig>({ cwd: directory, configName: "config", configFileMode: 0o600, defaults: DEFAULTS });
  } catch {
    // The parser's own message can quote the file, which holds the credential: leave it out.
    throw new CliError(`The config file ${file} is not valid JSON, so it cannot be read.`, {
      hint: "Fix the file or delete it, then run `wheelsai login` again.",
    });
  }
  tighten(file, 0o600);

  return {
    path: conf.path,
    get: (key) => {
      const value: unknown = conf.get(key);
      return typeof value === "string" ? value : "";
    },
    set: (values) => {
      conf.set(values);
      tighten(file, 0o600);
    },
  };
}

/** A store that lives only in memory. */
export function memoryStore(initial: Partial<StoredConfig> = {}): ConfigStore {
  const values: StoredConfig = { ...DEFAULTS, ...initial };
  return {
    path: "(memory)",
    get: (key) => values[key],
    set: (changes) => void Object.assign(values, changes),
  };
}

let opened: ConfigStore | undefined;

/** The user's config file, opened on first use so that a broken file fails the command, not the import. */
export function defaultStore(): ConfigStore {
  opened ??= openFileStore(configDirectory());
  return opened;
}

export interface ResolvedConfig {
  apiUrl: string;
  /** Where the API URL came from. `default` means nobody chose it. */
  apiUrlSource: "env" | "config" | "default";
  webUrl: string;
  /** Where the web URL came from. */
  webUrlSource: "env" | "config" | "derived";
  token: string;
  apiKey: string;
  /** Which credential requests will carry. */
  credential: "token" | "apiKey" | "none";
  /** Where the credential came from. */
  credentialSource: "env" | "config" | "none";
  /**
   * Set when a saved credential exists but is not being used, because it was issued for a
   * different API URL (`savedFor`) or by a version that did not record one (`savedFor: null`).
   */
  withheld?: { savedFor: string | null };
  configPath: string;
}

/**
 * Stored settings with environment overrides (WHEELSAI_API_URL, WHEELSAI_WEB_URL,
 * WHEELSAI_API_KEY, WHEELSAI_TOKEN), so CI never has to write a config file.
 * A credential from the environment replaces the stored ones entirely and goes wherever
 * the API URL points. A saved credential is bound to the API URL it was issued for: when
 * the URL in effect is another server, it is withheld rather than sent there.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, store: ConfigStore = defaultStore()): ResolvedConfig {
  const envApi = env.WHEELSAI_API_URL?.trim();
  const storedApi = store.get("apiUrl").trim();
  const apiUrl = envApi
    ? parseBaseUrl(envApi, "WHEELSAI_API_URL")
    : storedApi
      ? parseBaseUrl(storedApi, `apiUrl in ${store.path}`)
      : DEFAULT_API_URL;
  const apiUrlSource = envApi ? "env" : storedApi ? "config" : "default";

  const envWeb = env.WHEELSAI_WEB_URL?.trim();
  const storedWeb = store.get("webUrl").trim();
  const webUrl = envWeb
    ? parseBaseUrl(envWeb, "WHEELSAI_WEB_URL")
    : storedWeb
      ? parseBaseUrl(storedWeb, `webUrl in ${store.path}`)
      : deriveWebUrl(apiUrl);
  const webUrlSource = envWeb ? "env" : storedWeb ? "config" : "derived";

  const envToken = env.WHEELSAI_TOKEN?.trim() ?? "";
  const envKey = env.WHEELSAI_API_KEY?.trim() ?? "";
  const fromEnv = Boolean(envToken || envKey);

  let token = envToken;
  let apiKey = envKey;
  let withheld: ResolvedConfig["withheld"];
  if (!fromEnv) {
    const saved = savedCredential(store);
    if (saved.token || saved.apiKey) {
      if (saved.apiUrl && sameOrigin(saved.apiUrl, apiUrl)) {
        ({ token, apiKey } = saved);
      } else {
        withheld = { savedFor: saved.apiUrl || null };
      }
    }
  }

  return {
    apiUrl,
    apiUrlSource,
    webUrl,
    webUrlSource,
    token,
    apiKey,
    // The SDK prefers a session token over an API key when both are present.
    credential: token ? "token" : apiKey ? "apiKey" : "none",
    credentialSource: token || apiKey ? (fromEnv ? "env" : "config") : "none",
    ...(withheld && { withheld }),
    configPath: store.path,
  };
}

/** The saved credential and the API URL it belongs to, whatever URL is in effect now. */
export function savedCredential(store: ConfigStore = defaultStore()): { token: string; apiKey: string; apiUrl: string } {
  return { token: store.get("token"), apiKey: store.get("apiKey"), apiUrl: store.get("credentialUrl") };
}

/** Validate and save a URL setting; returns what was stored. An empty webUrl goes back to the derived default. */
export function setSetting(key: ConfigKey, value: string, store: ConfigStore = defaultStore()): string {
  const stored = key === "webUrl" && value.trim() === "" ? "" : parseBaseUrl(value, key);
  store.set({ [key]: stored });
  return stored;
}

/**
 * Store an API key together with the API URL it was checked against, which becomes the
 * URL in use. The session token is cleared so it cannot shadow the key.
 */
export function saveApiKey(apiKey: string, apiUrl: string, store: ConfigStore = defaultStore()): void {
  store.set({ apiKey, token: "", credentialUrl: apiUrl, apiUrl });
}

/** Store a session token with the API URL that issued it. The API key is cleared so the two never disagree. */
export function saveToken(token: string, apiUrl: string, store: ConfigStore = defaultStore()): void {
  store.set({ token, apiKey: "", credentialUrl: apiUrl, apiUrl });
}

export function clearCredentials(store: ConfigStore = defaultStore()): void {
  store.set({ token: "", apiKey: "", credentialUrl: "" });
}
