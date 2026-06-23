import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { executeSetupPlan, redact, statePath } from "../src/setup";
import type {
	SetupAdapter,
	SetupApplyResult,
	SetupCheckResult,
	SetupPlan,
	SetupState,
	SetupStep,
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
});
