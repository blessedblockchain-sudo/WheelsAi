import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { missingCredential } from "../src/client.js";
import {
  clearCredentials,
  configDirectory,
  memoryStore,
  openFileStore,
  resolveConfig,
  saveApiKey,
  saveToken,
  savedCredential,
  setSetting,
} from "../src/config.js";
import { CliError } from "../src/errors.js";

const PROD = "https://api.example.com";
const KEY = "wheels_live_prodkey1234567890";

describe("resolveConfig", () => {
  it("shows the local default when nothing was ever set, and says nobody chose it", () => {
    const config = resolveConfig({}, memoryStore());
    assert.equal(config.apiUrl, "http://localhost:4000");
    assert.equal(config.apiUrlSource, "default");
    assert.equal(config.webUrl, "http://localhost:3000");
    assert.equal(config.webUrlSource, "derived");
    assert.equal(config.credential, "none");
    assert.equal(config.credentialSource, "none");
    assert.equal(config.withheld, undefined);
  });

  it("prefers the environment over the config file for URLs and credentials", () => {
    const store = memoryStore();
    saveApiKey(KEY, PROD, store);
    setSetting("webUrl", "https://app.example.com", store);
    const config = resolveConfig(
      { WHEELSAI_API_URL: "https://ci.example.test/", WHEELSAI_WEB_URL: "https://web.example.test", WHEELSAI_API_KEY: " wheels_live_cikey " },
      store,
    );
    assert.equal(config.apiUrl, "https://ci.example.test");
    assert.equal(config.apiUrlSource, "env");
    assert.equal(config.webUrl, "https://web.example.test");
    assert.equal(config.webUrlSource, "env");
    assert.equal(config.apiKey, "wheels_live_cikey");
    assert.equal(config.credentialSource, "env");
    assert.equal(config.withheld, undefined, "the saved key is simply not in play");
  });

  it("uses a session token over an API key when the environment gives both", () => {
    const config = resolveConfig({ WHEELSAI_TOKEN: "jwt.a.b", WHEELSAI_API_KEY: KEY, WHEELSAI_API_URL: PROD }, memoryStore());
    assert.equal(config.credential, "token");
    assert.equal(config.token, "jwt.a.b");
  });

  it("an environment credential replaces the saved ones entirely", () => {
    const store = memoryStore();
    saveToken("jwt.saved", PROD, store);
    const config = resolveConfig({ WHEELSAI_API_KEY: KEY }, store);
    assert.equal(config.token, "", "the saved token must not shadow the environment's key");
    assert.equal(config.credential, "apiKey");
  });

  it("refuses a URL from the environment or the file that is not a URL, naming it", () => {
    assert.throws(() => resolveConfig({ WHEELSAI_API_URL: "api.example.com" }, memoryStore()), /^CliError: WHEELSAI_API_URL is not a URL/);
    assert.throws(() => resolveConfig({ WHEELSAI_WEB_URL: "ftp://x" }, memoryStore()), /WHEELSAI_WEB_URL must start with https/);
    assert.throws(() => resolveConfig({}, memoryStore({ apiUrl: "nonsense" })), /apiUrl in \(memory\) is not a URL/);
  });
});

describe("a saved credential is bound to the API URL it was issued for", () => {
  it("is used on that server, including under a path or with the default port spelled out", () => {
    const store = memoryStore();
    saveApiKey(KEY, PROD, store);
    assert.equal(resolveConfig({}, store).apiKey, KEY);
    assert.equal(resolveConfig({}, store).apiUrl, PROD, "logging in also makes that URL the one in use");
    assert.equal(resolveConfig({ WHEELSAI_API_URL: `${PROD}:443/` }, store).apiKey, KEY);
  });

  it("is withheld when `config set apiUrl` points somewhere else, and comes back with the URL", () => {
    const store = memoryStore();
    saveApiKey(KEY, PROD, store);
    setSetting("apiUrl", "http://staging:4000", store);

    const config = resolveConfig({}, store);
    assert.equal(config.apiKey, "");
    assert.equal(config.token, "");
    assert.equal(config.credential, "none");
    assert.deepEqual(config.withheld, { savedFor: PROD });

    const error = missingCredential(config);
    assert.match(error.message, /saved credentials are for https:\/\/api\.example\.com, so they were not sent to http:\/\/staging:4000/);
    assert.match(error.hint ?? "", /wheelsai login --url http:\/\/staging:4000/);
    assert.doesNotMatch(`${error.message}${error.hint}`, new RegExp(KEY));

    setSetting("apiUrl", PROD, store);
    assert.equal(resolveConfig({}, store).apiKey, KEY);
  });

  it("is withheld from a WHEELSAI_API_URL that is another server (a project .env, a CI variable)", () => {
    const store = memoryStore();
    saveToken("jwt.saved", PROD, store);
    for (const other of ["https://evil.example.test", "http://api.example.com", "https://api.example.com:8443", "https://api.example.com.evil.test"]) {
      const config = resolveConfig({ WHEELSAI_API_URL: other }, store);
      assert.equal(config.token, "", other);
      assert.deepEqual(config.withheld, { savedFor: PROD }, other);
    }
  });

  it("withholds a credential saved without a URL (an older version's file) rather than guess", () => {
    const store = memoryStore({ apiUrl: PROD, apiKey: KEY });
    const config = resolveConfig({}, store);
    assert.equal(config.apiKey, "");
    assert.deepEqual(config.withheld, { savedFor: null });
    assert.match(missingCredential(config).message, /do not record which API they belong to/);
  });

  it("saving one kind of credential clears the other, and both carry their URL", () => {
    const store = memoryStore();
    saveToken("jwt.saved", PROD, store);
    saveApiKey(KEY, "https://other.example.test", store);
    assert.deepEqual(savedCredential(store), { token: "", apiKey: KEY, apiUrl: "https://other.example.test" });
    saveToken("jwt.again", PROD, store);
    assert.deepEqual(savedCredential(store), { token: "jwt.again", apiKey: "", apiUrl: PROD });
    clearCredentials(store);
    assert.deepEqual(savedCredential(store), { token: "", apiKey: "", apiUrl: "" });
    assert.equal(resolveConfig({}, store).apiUrl, PROD, "logging out keeps the URL");
  });

  it("says 'not logged in' only when nothing is saved", () => {
    const error = missingCredential(resolveConfig({}, memoryStore()));
    assert.equal(error.message, "Not logged in.");
    assert.doesNotMatch(error.hint ?? "", /--api-key </, "does not teach putting the key on the command line");
  });
});

describe("setSetting", () => {
  it("validates and normalizes, and an empty webUrl goes back to derived", () => {
    const store = memoryStore();
    assert.equal(setSetting("apiUrl", " https://api.example.com/ ", store), PROD);
    assert.equal(setSetting("webUrl", "https://app.example.com/", store), "https://app.example.com");
    assert.equal(resolveConfig({}, store).webUrlSource, "config");
    assert.equal(setSetting("webUrl", "", store), "");
    assert.equal(resolveConfig({}, store).webUrl, "https://example.com");
    assert.throws(() => setSetting("apiUrl", "", store), CliError);
    assert.throws(() => setSetting("apiUrl", "https://u:p@example.com", store), CliError);
    assert.equal(store.get("apiUrl"), PROD, "a refused value changes nothing");
  });
});

describe("configDirectory", () => {
  it("is where conf keeps the wheelsai project on each platform, unless overridden", () => {
    assert.equal(configDirectory({}, "linux", "/home/u"), "/home/u/.config/wheelsai-nodejs");
    assert.equal(configDirectory({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u"), "/x/wheelsai-nodejs");
    assert.equal(configDirectory({}, "darwin", "/Users/u"), "/Users/u/Library/Preferences/wheelsai-nodejs");
    assert.equal(configDirectory({ APPDATA: "/appdata" }, "win32", "/u"), path.join("/appdata", "wheelsai-nodejs", "Config"));
    assert.equal(configDirectory({ WHEELSAI_CONFIG_DIR: "/tmp/elsewhere" }, "linux", "/home/u"), "/tmp/elsewhere");
  });
});

describe("the config file", { skip: process.platform === "win32" }, () => {
  const scratch = () => mkdtempSync(path.join(tmpdir(), "wheelsai-config-"));
  const mode = (target: string) => statSync(target).mode & 0o777;

  it("is created private: directory 0700, file 0600", () => {
    const root = scratch();
    try {
      const directory = path.join(root, "nested", "wheelsai");
      const store = openFileStore(directory);
      saveApiKey(KEY, PROD, store);
      assert.equal(mode(directory), 0o700);
      assert.equal(mode(store.path), 0o600);
      assert.equal(JSON.parse(readFileSync(store.path, "utf8")).credentialUrl, PROD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tightens a directory and file left open by an earlier version, on open and on every write", () => {
    const root = scratch();
    try {
      const directory = path.join(root, "wheelsai");
      mkdirSync(directory, { mode: 0o755 });
      chmodSync(directory, 0o755);
      const file = path.join(directory, "config.json");
      writeFileSync(file, JSON.stringify({ apiUrl: PROD, webUrl: "", token: "", apiKey: KEY, credentialUrl: PROD }), { mode: 0o644 });
      chmodSync(file, 0o644);

      const store = openFileStore(directory);
      assert.equal(mode(directory), 0o700, "directory tightened on open");
      assert.equal(mode(file), 0o600, "file tightened on open, before any write");
      assert.equal(resolveConfig({}, store).apiKey, KEY);

      chmodSync(file, 0o664);
      setSetting("webUrl", "https://app.example.com", store);
      assert.equal(mode(file), 0o600, "and again after a write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a malformed file by path, without quoting what is in it", () => {
    const root = scratch();
    try {
      writeFileSync(path.join(root, "config.json"), `{"apiKey": "${KEY}", `);
      assert.throws(() => openFileStore(root), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.ok(err.message.includes(path.join(root, "config.json")));
        assert.match(err.hint ?? "", /Fix the file or delete it/);
        assert.doesNotMatch(`${err.message}${err.hint}${err.stack}`, /wheels_live_/);
        return true;
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a hand-edited value of the wrong type as unset instead of crashing", () => {
    const root = scratch();
    try {
      writeFileSync(path.join(root, "config.json"), JSON.stringify({ apiUrl: 5, token: null }));
      const store = openFileStore(root);
      assert.equal(store.get("apiUrl"), "");
      assert.equal(resolveConfig({}, store).apiUrlSource, "default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
