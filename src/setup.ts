import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { toJson } from "./files";
import type {
	CreateContext,
	RecipeId,
	SetupAdapter,
	SetupApplyResult,
	SetupCheckResult,
	SetupPlan,
	SetupState,
	SetupStep,
	SetupStepFailure,
	SetupStepState,
} from "./types";

const secretKeyPattern = /(secret|token|key|password|credential|deployKey|apiKey)/i;

export function redact(value: unknown): unknown {
	if (typeof value === "string") {
		return looksSecret(value) ? "[REDACTED]" : value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => redact(item));
	}

	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			output[key] =
				secretKeyPattern.test(key) && !isStructuredValue(nested)
					? "[REDACTED]"
					: redact(nested);
		}
		return output;
	}

	return value;
}

function isStructuredValue(value: unknown): boolean {
	return value !== null && typeof value === "object";
}

function looksSecret(value: string): boolean {
	return /^(prod|preview|dev):/.test(value) || value.length > 80;
}

export function contextHash(plan: SetupPlan): string {
	const hashInput = {
		recipe: plan.recipe,
		project: plan.project,
		options: plan.options,
		scopes: plan.scopes,
		stepIds: plan.steps.map((step) => step.id),
	};
	return createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
}

export function createInitialState(plan: SetupPlan): SetupState {
	return {
		version: 1,
		projectSlug: plan.project.slug,
		recipe: plan.recipe,
		contextHash: contextHash(plan),
		updatedAt: new Date().toISOString(),
		steps: Object.fromEntries(
			plan.steps.map((step) => [
				step.id,
				{
					status: "pending",
					attempts: 0,
				},
			]),
		),
	};
}

export function statePath(projectPath: string): string {
	return join(projectPath, ".m10n", "setup-state.json");
}

export async function readSetupState(projectPath: string): Promise<SetupState | undefined> {
	const path = statePath(projectPath);
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, "utf8")) as SetupState;
}

export async function writeSetupState(projectPath: string, state: SetupState): Promise<void> {
	const path = statePath(projectPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, toJson(redact({ ...state, updatedAt: new Date().toISOString() })));
}

export function setupManifest(plan: SetupPlan) {
	return {
		version: plan.version,
		recipe: plan.recipe,
		project: plan.project,
		options: plan.options,
		scopes: plan.scopes,
		steps: plan.steps.map(({ id, title, kind, dependsOn, adapter, action, metadata }) => ({
			id,
			title,
			kind,
			dependsOn,
			adapter,
			action,
			metadata,
		})),
	};
}

export function buildSetupPlan(recipe: RecipeId, ctx: CreateContext): SetupPlan {
	const steps: SetupStep[] = [];
	const add = (step: SetupStep) => steps.push(step);

	add({
		id: "preflight.local",
		title: "Verify local tools and authenticated CLIs",
		kind: "preflight",
		dependsOn: [],
		adapter: "local",
		action: "check-tools",
		metadata: {
			tools: ["bun", "git", "gh", "convex", ...(ctx.deploy === "vercel" ? ["vercel"] : [])],
		},
	});

	add({
		id: "preflight.scopes",
		title: "Verify selected provider scopes",
		kind: "preflight",
		dependsOn: ["preflight.local"],
		adapter: "local",
		action: "check-scopes",
		metadata: {
			githubOwner: ctx.githubOwner ?? null,
			vercelScope: ctx.vercelScope ?? null,
			convexTeam: ctx.convexTeam ?? null,
		},
	});

	add({
		id: "generate.files",
		title: "Write deterministic recipe files",
		kind: "generate",
		dependsOn: ["preflight.scopes"],
		adapter: "local",
		action: "write-files",
	});

	add({
		id: "install.deps",
		title: "Install dependencies",
		kind: "install",
		dependsOn: ["generate.files"],
		adapter: "local",
		action: "bun-install",
	});

	add({
		id: "git.init",
		title: "Initialize git and first commit",
		kind: "git",
		dependsOn: ["generate.files"],
		adapter: "git",
		action: "init-commit",
	});

	add({
		id: "github.repo",
		title: "Create GitHub repository and push",
		kind: "github",
		dependsOn: ["git.init"],
		adapter: "github",
		action: "repo-create-push",
		metadata: {
			owner: ctx.githubOwner ?? null,
			visibility: ctx.visibility,
		},
	});

	add({
		id: "convex.init",
		title: "Initialize Convex project",
		kind: "convex",
		dependsOn: ["install.deps"],
		adapter: "convex",
		action: "init-project",
		metadata: {
			team: ctx.convexTeam ?? null,
		},
	});

	if (ctx.auth === "workos") {
		add({
			id: "convex.authkit",
			title: "Configure Convex-managed WorkOS AuthKit",
			kind: "auth",
			dependsOn: ["convex.init"],
			adapter: "convex",
			action: "authkit-configure",
			blocker: {
				reason: "WorkOS/AuthKit provisioning may require provider consent or dashboard setup.",
				nextAction: "Complete the Convex AuthKit setup, then rerun with --resume.",
			},
			metadata: {
				capability: "authkitManaged",
			},
		});
	}

	if (ctx.deploy === "vercel") {
		add({
			id: "vercel.product.create",
			title: "Create Vercel product project",
			kind: "vercel",
			dependsOn: ["github.repo"],
			adapter: "vercel",
			action: "create-product-project",
			metadata: {
				projectName: ctx.projectSlug,
				outputDirectory: "apps/web/dist",
			},
		});

		const productEnvDeps = ["vercel.product.create"];

		if (!ctx.noPreview) {
			productEnvDeps.push("convex.deployKey.preview");
			add({
				id: "convex.deployKey.preview",
				title: "Collect and store Convex preview deploy key",
				kind: "convex",
				dependsOn: ["convex.init", "vercel.product.create"],
				adapter: "convex",
				action: "deploy-key-preview",
				blocker: {
					reason: "Convex preview deploy keys are dashboard-minted and cannot be generated headlessly.",
					nextAction: "Create a Convex Preview deploy key, then rerun with --resume to enter it.",
				},
				metadata: {
					secretState: "deployKeyPreviewSet",
				},
			});
		}

		if (ctx.production) {
			productEnvDeps.push("convex.deployKey.production");
			add({
				id: "convex.deployKey.production",
				title: "Collect and store Convex production deploy key",
				kind: "convex",
				dependsOn: ["convex.init", "vercel.product.create"],
				adapter: "convex",
				action: "deploy-key-production",
				blocker: {
					reason: "Convex production deploy keys are dashboard-minted and cannot be generated headlessly.",
					nextAction: "Create a Convex Production deploy key, then rerun with --resume to enter it.",
				},
				metadata: {
					secretState: "deployKeyProductionSet",
				},
			});
		}

		add({
			id: "vercel.marketing.create",
			title: "Create Vercel marketing project",
			kind: "vercel",
			dependsOn: ["github.repo", "vercel.product.create"],
			adapter: "vercel",
			action: "create-marketing-project",
			metadata: {
				projectName: `${ctx.projectSlug}-marketing`,
				outputDirectory: "apps/marketing/dist",
			},
		});

		add({
			id: "vercel.product.env",
			title: "Set product Vercel environment variables",
			kind: "env",
			dependsOn: productEnvDeps,
			adapter: "vercel",
			action: "set-product-env",
		});

		add({
			id: "vercel.marketing.env",
			title: "Set marketing Vercel environment variables",
			kind: "env",
			dependsOn: ["vercel.marketing.create", "vercel.product.create"],
			adapter: "vercel",
			action: "set-marketing-env",
			metadata: {
				VITE_APP_URL: "product-production-domain",
			},
		});

		if (!ctx.noPreview) {
			add({
				id: "deploy.product.preview",
				title: "Deploy product preview",
				kind: "deploy",
				dependsOn: ["vercel.product.env"],
				adapter: "vercel",
				action: "deploy-product-preview",
			});

			add({
				id: "deploy.marketing.preview",
				title: "Deploy marketing preview",
				kind: "deploy",
				dependsOn: ["vercel.marketing.env", "deploy.product.preview"],
				adapter: "vercel",
				action: "deploy-marketing-preview",
			});
		}

		if (ctx.production) {
			add({
				id: "deploy.product.production",
				title: "Deploy product production",
				kind: "deploy",
				dependsOn: ["vercel.product.env"],
				adapter: "vercel",
				action: "deploy-product-production",
			});

			add({
				id: "deploy.marketing.production",
				title: "Deploy marketing production",
				kind: "deploy",
				dependsOn: ["vercel.marketing.env", "deploy.product.production"],
				adapter: "vercel",
				action: "deploy-marketing-production",
			});
		}
	}

	add({
		id: "verify.local",
		title: "Run local recipe verification",
		kind: "verify",
		dependsOn: ["install.deps", "convex.init"],
		adapter: "local",
		action: "verify-local",
	});

	if (ctx.deploy === "vercel" && !ctx.noPreview) {
		add({
			id: "verify.cloud",
			title: "Verify cloud preview deployments",
			kind: "verify",
			dependsOn: ["deploy.product.preview", "deploy.marketing.preview"],
			adapter: "vercel",
			action: "verify-cloud",
		});
	}

	return {
		version: 1,
		recipe,
		project: {
			name: ctx.projectName,
			slug: ctx.projectSlug,
			packageScope: ctx.packageScope,
		},
		options: {
			auth: ctx.auth,
			billing: ctx.billing,
			deploy: ctx.deploy,
			packageManager: ctx.packageManager,
			shape: ctx.shape,
			visibility: ctx.visibility,
			noPreview: ctx.noPreview,
			production: ctx.production,
		},
		scopes: {
			githubOwner: ctx.githubOwner,
			vercelScope: ctx.vercelScope,
			convexTeam: ctx.convexTeam,
		},
		steps,
	};
}

export class BlockerAdapter implements SetupAdapter {
	async check(step: SetupStep, state: SetupState): Promise<SetupCheckResult> {
		if (step.blocker) {
			return {
				status: "blocked",
				failure: blockerFailure(step),
			};
		}
		return { status: "missing" };
	}

	async apply(step: SetupStep, input: { state: SetupState; interactive: boolean }): Promise<SetupApplyResult> {
		if (step.blocker) {
			return {
				status: "blocked",
				failure: blockerFailure(step),
			};
		}
		return { status: "skipped" };
	}

	async verify(step: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		return {
			status: result.status === "completed" || result.status === "skipped" ? "present" : "blocked",
			resourceRefs: result.resourceRefs,
			failure: result.failure,
		};
	}

	redact(value: unknown): unknown {
		return redact(value);
	}
}

function blockerFailure(step: SetupStep): SetupStepFailure {
	return {
		kind: "blocker",
		message: step.blocker?.reason ?? "This setup step requires human input.",
		nextAction: step.blocker?.nextAction,
	};
}

export async function executeSetupPlan(args: {
	plan: SetupPlan;
	projectPath: string;
	adapters: Record<string, SetupAdapter>;
	interactive: boolean;
	initialState?: SetupState;
	onStep?: (step: SetupStep, result: SetupApplyResult) => void;
}): Promise<SetupState> {
	const expectedHash = contextHash(args.plan);
	const state = args.initialState ?? createInitialState(args.plan);
	if (state.contextHash !== expectedHash) {
		throw new Error("Setup state does not match the current setup plan.");
	}

	let madeProgress = true;
	while (madeProgress) {
		madeProgress = false;

		for (const step of args.plan.steps) {
			const current = state.steps[step.id] ?? { status: "pending", attempts: 0 };
			if (current.status === "completed" || current.status === "skipped") continue;

			const depsDone = step.dependsOn.every(
				(dep) => state.steps[dep]?.status === "completed" || state.steps[dep]?.status === "skipped",
			);
			if (!depsDone) continue;

			const adapter = args.adapters[step.adapter] ?? args.adapters.default;
			if (!adapter) {
				throw new Error(`No setup adapter registered for "${step.adapter}".`);
			}

			const checked = await adapter.check(step, state);
			current.checkedAt = new Date().toISOString();
			if (checked.status === "present") {
				state.steps[step.id] = {
					...current,
					status: "completed",
					resourceRefs: checked.resourceRefs,
					completedAt: new Date().toISOString(),
				};
				madeProgress = true;
				continue;
			}

			if (checked.status === "blocked") {
				state.steps[step.id] = {
					...current,
					status: "blocked",
					failure: checked.failure,
				};
				await writeSetupState(args.projectPath, state);
				// Don't return here - continue with other steps that don't depend on this one
				continue;
			}

			current.attempts += 1;
			current.status = "running";
			state.steps[step.id] = current;

			const result = await adapter.apply(step, {
				state,
				interactive: args.interactive,
			});
			args.onStep?.(step, result);
			const verified = await adapter.verify(step, result);
			const finalStatus =
				result.status === "completed"
					? verificationStatus(verified)
					: result.status;
			state.steps[step.id] = {
				...current,
				status: finalStatus,
				resourceRefs: result.resourceRefs ?? verified.resourceRefs,
				completedAt: finalStatus === "completed" ? new Date().toISOString() : undefined,
				failure: result.failure ?? verified.failure ?? verificationFailure(verified),
			};

			await writeSetupState(args.projectPath, state);
			// Treat blocked as progress so other independent steps can run
			madeProgress = true;
			// Only return early on fatal failures
			if (finalStatus === "failed") return state;
		}
	}

	await writeSetupState(args.projectPath, state);
	return state;
}

function verificationStatus(verified: SetupCheckResult): SetupStepState["status"] {
	if (verified.status === "present") return "completed";
	if (verified.status === "blocked") return "blocked";
	return "failed";
}

function verificationFailure(verified: SetupCheckResult): SetupStepFailure | undefined {
	if (verified.status === "present") return undefined;
	return {
		kind: verified.status === "blocked" ? "blocker" : "retryable",
		message:
			verified.status === "blocked"
				? "Step verification is blocked."
				: "Step verification did not find the expected provider state.",
		nextAction: "Fix the provider state and rerun with --resume.",
	};
}
