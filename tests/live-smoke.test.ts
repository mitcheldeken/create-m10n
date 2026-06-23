import { describe, expect, test } from "bun:test";
import {
	ConvexAdapter,
	createEnvSetupSecretProvider,
} from "../src/adapters";
import type { SetupState, SetupStep } from "../src/types";
import {
	assertLiveSmokeEnabled,
	createCleanupManifest,
	createDisposableSlug,
	stateContainsSecret,
} from "../scripts/live-smoke";

describe("live smoke gate and manifest helpers", () => {
	test("refuses to run without the explicit live smoke gate", () => {
		expect(() => assertLiveSmokeEnabled({})).toThrow(/CREATE_M10N_LIVE_SMOKE=1/);
		expect(() => assertLiveSmokeEnabled({ CREATE_M10N_LIVE_SMOKE: "1" })).not.toThrow();
	});

	test("creates a deterministic disposable smoke slug", () => {
		const slug = createDisposableSlug(new Date("2026-06-23T12:34:56.000Z"), "abc123");

		expect(slug).toBe("m10n-smoke-20260623-abc123");
	});

	test("starts a cleanup manifest with Convex manual cleanup instructions", () => {
		const manifest = createCleanupManifest("m10n-smoke-20260623-abc123", "/tmp/m10n-smoke-20260623-abc123");

		expect(manifest.manifestPath).toBe("/tmp/m10n-smoke-20260623-abc123.cleanup.json");
		expect(manifest.cleanup.githubRepo).toBe("pending");
		expect(manifest.cleanup.convex).toBe("manual");
		expect(manifest.resources.convex?.manualCleanup).toContain("m10n-smoke-20260623-abc123");
	});

	test("detects deploy keys only when raw env secrets are persisted", () => {
		const env = {
			CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY: "preview:secret-value",
		};

		expect(stateContainsSecret('{"deployKeyPreviewSet":"true"}', env)).toBe(false);
		expect(stateContainsSecret('{"raw":"preview:secret-value"}', env)).toBe(true);
	});
});

describe("setup secret provider", () => {
	test("reads Convex deploy keys from env by requested name", async () => {
		const provider = createEnvSetupSecretProvider({
			CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY: "preview:ci-key",
		});

		expect(
			await provider({
				provider: "convex",
				name: "previewDeployKey",
				envName: "CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY",
			}),
		).toBe("preview:ci-key");
	});

	test("uses an env deploy key in non-interactive setup without persisting the secret", async () => {
		let capturedStdin = "";
		const adapter = new ConvexAdapter({
			projectPath: "/tmp/create-m10n-secret-test",
			context: {
				projectName: "Secret Test",
				projectSlug: "secret-test",
				packageScope: "@secret-test",
				auth: "none",
				billing: "none",
				deploy: "vercel",
				packageManager: "bun",
				shape: "standalone",
				visibility: "private",
				noPreview: false,
				production: false,
			},
			project: { files: [], nextSteps: [], verification: [] },
			skipChecks: true,
			secretProvider: createEnvSetupSecretProvider({
				CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY: "preview:ci-key",
			}),
			commands: {
				runWithStdin: (_cwd: string, value: string) => async () => {
					capturedStdin = value;
					return { ok: true, stdout: "", stderr: "" };
				},
			},
		} as never);
		const step: SetupStep = {
			id: "convex.deployKey.preview",
			title: "Collect and store Convex preview deploy key",
			kind: "convex",
			dependsOn: [],
			adapter: "convex",
			action: "deploy-key-preview",
		};
		const state: SetupState = {
			version: 1,
			projectSlug: "secret-test",
			recipe: "vite-spa-convex",
			contextHash: "hash",
			updatedAt: new Date().toISOString(),
			steps: {},
		};

		const result = await adapter.apply(step, { state, interactive: false });

		expect(result.status).toBe("completed");
		expect(result.resourceRefs).toEqual({ deployKeyPreviewSet: "true" });
		expect(capturedStdin).toBe("preview:ci-key");
	});
});
