import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { executeSetupPlan, redact, statePath, buildSetupPlan } from "../src/setup";
import { ConvexAdapter } from "../src/adapters";
import type {
	SetupAdapter,
	SetupApplyResult,
	SetupCheckResult,
	SetupPlan,
	SetupState,
	SetupStep,
	CreateContext,
} from "../src/types";

function fakePlan(): SetupPlan {
	return {
		version: 1,
		recipe: "vite-spa-convex",
		project: {
			name: "Test App",
			slug: "test-app",
			packageScope: "@test-app",
		},
		options: {
			auth: "none",
			billing: "none",
			deploy: "none",
			packageManager: "bun",
			shape: "standalone",
			visibility: "private",
			noPreview: false,
			production: false,
		},
		scopes: {},
		steps: [
			{
				id: "third",
				title: "Third",
				kind: "verify",
				dependsOn: ["second"],
				adapter: "fake",
				action: "third",
			},
			{
				id: "first",
				title: "First",
				kind: "preflight",
				dependsOn: [],
				adapter: "fake",
				action: "first",
			},
			{
				id: "second",
				title: "Second",
				kind: "install",
				dependsOn: ["first"],
				adapter: "fake",
				action: "second",
			},
		],
	};
}

class FakeAdapter implements SetupAdapter {
	readonly applied: string[] = [];

	async check(): Promise<SetupCheckResult> {
		return { status: "missing" };
	}

	async apply(step: SetupStep): Promise<SetupApplyResult> {
		this.applied.push(step.id);
		return { status: "completed", resourceRefs: { step: step.id } };
	}

	async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		return { status: "present", resourceRefs: result.resourceRefs };
	}

	redact(value: unknown): unknown {
		return redact(value);
	}
}

describe("setup executor", () => {
	test("walks dependency-ready steps until an out-of-order DAG completes", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		const adapter = new FakeAdapter();

		try {
			const state = await executeSetupPlan({
				plan: fakePlan(),
				projectPath: root,
				adapters: { fake: adapter },
				interactive: false,
			});

			expect(adapter.applied).toEqual(["first", "second", "third"]);
			expect(state.steps.first.status).toBe("completed");
			expect(state.steps.second.status).toBe("completed");
			expect(state.steps.third.status).toBe("completed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("state redaction preserves structured step entries while redacting secret refs", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		const adapter: SetupAdapter = {
			async check(): Promise<SetupCheckResult> {
				return { status: "missing" };
			},
			async apply(): Promise<SetupApplyResult> {
				return {
					status: "completed",
					resourceRefs: {
						deployKeyPreviewSet: "preview:secret-value",
						publicRef: "project_123",
					},
				};
			},
			async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
				return { status: "present", resourceRefs: result.resourceRefs };
			},
			redact,
		};
		const plan = fakePlan();
		plan.steps = [plan.steps[1]];

		try {
			await executeSetupPlan({
				plan,
				projectPath: root,
				adapters: { fake: adapter },
				interactive: false,
			});
			const persisted = JSON.parse(await readFile(statePath(root), "utf8")) as SetupState;

			expect(persisted.steps.first.status).toBe("completed");
			expect(persisted.steps.first.resourceRefs?.deployKeyPreviewSet).toBe("[REDACTED]");
			expect(persisted.steps.first.resourceRefs?.publicRef).toBe("project_123");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("marks a completed step as failed when verification cannot find provider state", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		const adapter: SetupAdapter = {
			async check(): Promise<SetupCheckResult> {
				return { status: "missing" };
			},
			async apply(): Promise<SetupApplyResult> {
				return { status: "completed" };
			},
			async verify(): Promise<SetupCheckResult> {
				return { status: "missing" };
			},
			redact,
		};
		const plan = fakePlan();
		plan.steps = [plan.steps[1]];

		try {
			const state = await executeSetupPlan({
				plan,
				projectPath: root,
				adapters: { fake: adapter },
				interactive: false,
			});

			expect(state.steps.first.status).toBe("failed");
			expect(state.steps.first.failure?.kind).toBe("retryable");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("authkit can be detected as complete from convex.json", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		
		try {
			// Create a fake convex.json with authkit configured
			await writeFile(
				join(root, "convex.json"),
				JSON.stringify({
					authInfo: [
						{
							applicationID: "authkit_12345",
							domain: "https://example.com"
						}
					]
				})
			);

			const context: CreateContext = {
				projectName: "test",
				projectSlug: "test",
				packageScope: "@test",
				auth: "workos",
				billing: "none",
				deploy: "none",
				packageManager: "bun",
				shape: "standalone",
				visibility: "private",
				noPreview: false,
				production: false,
			};

			const plan = buildSetupPlan("vite-spa-convex", context);
			const authkitStep = plan.steps.find((s) => s.id === "convex.authkit");
			
			if (!authkitStep) {
				throw new Error("AuthKit step not found in plan");
			}

			const adapter = new ConvexAdapter({
				projectPath: root,
				context,
				project: { files: [], nextSteps: [], verification: [] },
				skipChecks: false,
			});

			const state: SetupState = {
				version: 1,
				projectSlug: "test",
				recipe: "vite-spa-convex",
				contextHash: "test",
				updatedAt: new Date().toISOString(),
				steps: {},
			};

			const result = await adapter.check(authkitStep, state);
			
			expect(result.status).toBe("present");
			expect(result.resourceRefs?.authkitConfigured).toBe("true");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("authkit step can be resumed when marked complete in state", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		
		try {
			const context: CreateContext = {
				projectName: "test",
				projectSlug: "test",
				packageScope: "@test",
				auth: "workos",
				billing: "none",
				deploy: "none",
				packageManager: "bun",
				shape: "standalone",
				visibility: "private",
				noPreview: false,
				production: false,
			};

			const plan = buildSetupPlan("vite-spa-convex", context);
			const authkitStep = plan.steps.find((s) => s.id === "convex.authkit");
			
			if (!authkitStep) {
				throw new Error("AuthKit step not found in plan");
			}

			const adapter = new ConvexAdapter({
				projectPath: root,
				context,
				project: { files: [], nextSteps: [], verification: [] },
				skipChecks: false,
			});

			// Simulate state where authkit was previously marked complete
			const state: SetupState = {
				version: 1,
				projectSlug: "test",
				recipe: "vite-spa-convex",
				contextHash: "test",
				updatedAt: new Date().toISOString(),
				steps: {
					"convex.authkit": {
						status: "completed",
						attempts: 1,
						resourceRefs: { authkitConfigured: "true" },
					}
				},
			};

			const result = await adapter.check(authkitStep, state);
			
			expect(result.status).toBe("present");
			expect(result.resourceRefs?.authkitConfigured).toBe("true");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("blocked steps don't prevent independent steps from running", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-setup-"));
		
		try {
			const plan: SetupPlan = {
				version: 1,
				recipe: "vite-spa-convex",
				project: {
					name: "Test App",
					slug: "test-app",
					packageScope: "@test-app",
				},
				options: {
					auth: "none",
					billing: "none",
					deploy: "none",
					packageManager: "bun",
					shape: "standalone",
					visibility: "private",
					noPreview: false,
					production: false,
				},
				scopes: {},
				steps: [
					{
						id: "independent",
						title: "Independent",
						kind: "preflight",
						dependsOn: [],
						adapter: "fake",
						action: "independent",
					},
					{
						id: "blocker",
						title: "Blocker",
						kind: "auth",
						dependsOn: [],
						adapter: "fake",
						action: "blocker",
						blocker: {
							reason: "This step is blocked",
							nextAction: "Complete manually",
						},
					},
					{
						id: "dependent",
						title: "Dependent",
						kind: "verify",
						dependsOn: ["blocker"],
						adapter: "fake",
						action: "dependent",
					},
				],
			};

			const executed: string[] = [];
			const adapter: SetupAdapter = {
				async check(step: SetupStep): Promise<SetupCheckResult> {
					if (step.action === "blocker") {
						return {
							status: "blocked",
							failure: {
								kind: "blocker",
								message: "This step is blocked",
								nextAction: "Complete manually",
							},
						};
					}
					return { status: "missing" };
				},
				async apply(step: SetupStep): Promise<SetupApplyResult> {
					executed.push(step.id);
					if (step.action === "blocker") {
						return {
							status: "blocked",
							failure: {
								kind: "blocker",
								message: "This step is blocked",
								nextAction: "Complete manually",
							},
						};
					}
					return { status: "completed", resourceRefs: { step: step.id } };
				},
				async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
					return { status: "present", resourceRefs: result.resourceRefs };
				},
				redact,
			};

			const state = await executeSetupPlan({
				plan,
				projectPath: root,
				adapters: { fake: adapter },
				interactive: false,
			});

			// Independent step should have completed
			expect(state.steps.independent.status).toBe("completed");
			expect(executed).toContain("independent");

			// Blocker step should be blocked
			expect(state.steps.blocker.status).toBe("blocked");

			// Dependent step should not have run (still pending because blocker is blocked)
			expect(state.steps.dependent.status).toBe("pending");
			expect(executed).not.toContain("dependent");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
