import Conf from "conf";

interface CliConfig {
  apiUrl: string;
  token: string;
  apiKey: string;
}

const config = new Conf<CliConfig>({
  projectName: "wheelsai",
  defaults: {
    apiUrl: "http://localhost:4000",
    token: "",
    apiKey: "",
  },
});

export function getConfig() {
  return {
    apiUrl: config.get("apiUrl"),
    token: config.get("token"),
    apiKey: config.get("apiKey"),
  };
}

export function setConfig(key: keyof CliConfig, value: string) {
  config.set(key, value);
}

export function clearConfig() {
  config.clear();
}
