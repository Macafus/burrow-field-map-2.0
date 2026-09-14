import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode }) => {
  const localEnv = loadEnv(mode, process.cwd(), "");
  const databaseId =
    localEnv.D1_DATABASE_ID ??
    process.env.D1_DATABASE_ID ??
    SITE_CREATOR_PLACEHOLDER_DATABASE_ID;
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    keep_vars: true,
    vars: (
      mode === "development"
        ? {
            APP_PASSWORD:
              localEnv.APP_PASSWORD ?? process.env.APP_PASSWORD ?? "",
          }
        : {}
    ) as Record<string, string>,
    d1_databases: [
      {
        binding: "DB",
        database_name: "site-creator-d1",
        database_id: databaseId,
      },
    ],
    r2_buckets: [],
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
