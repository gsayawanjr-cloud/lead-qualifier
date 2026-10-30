import { existsSync, readFileSync } from "node:fs";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// Values that must never be shown in the dashboard after upload.
const SECRET_VARS = new Set(["HUBSPOT_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "LEAD_GMAIL_APP_PASSWORD"]);

/**
 * On a production deploy, uploads the local .env to the production environment so the two never
 * drift. TRIGGER_SECRET_KEY is dev-only. Without a local .env (e.g. CI), nothing is synced.
 */
function productionEnvVars() {
  if (!existsSync(".env")) return undefined;
  const env = Object.fromEntries(
    readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
  delete env.TRIGGER_SECRET_KEY;

  return Object.entries(env)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value, isSecret: SECRET_VARS.has(name) }));
}

export default defineConfig({
  // Your project ref from cloud.trigger.dev → Project settings (looks like "proj_abc123").
  // Use a new Trigger.dev project for this automation: deploying replaces every task in a project.
  project: "proj_vukdedfjgrfvzrpynjqd",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    extensions: [syncEnvVars(({ environment }) => (environment === "prod" ? productionEnvVars() : undefined))],
  },
});
