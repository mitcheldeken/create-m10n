import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeGeneratedFiles } from "./files";
import { redact } from "./setup";
import type {
	CreateContext,
	GeneratedProject,
	SetupAdapter,
	SetupApplyResult,
	SetupCheckResult,
	SetupState,
	SetupStep,
	SetupStepFailure,
} from "./types";

type BunShell = typeof import("bun").$;

type AdapterContext = {
	projectPath: string;
	context: CreateContext;
	project: GeneratedProject;
	skipChecks: boolean;
	secretProvider?: SetupSecretProvider;
	commands?: Partial<CommandFactories>;
	overrides?: Record<string, SetupAdapter>;
};

type CommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

type CommandTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<CommandResult>;

type CommandFactories = {
	run: CommandTag;
	runIn: (cwd: string) => CommandTag;
	runWithStdin: (cwd: string, value: string) => CommandTag;
};

export type SetupSecretRequest = {
	provider: "convex";
	name: "previewDeployKey" | "productionDeployKey";
	envName: string;
};

export type SetupSecretProvider = (
	request: SetupSecretRequest,
) => string | undefined | Promise<string | undefined>;

const convexDeployKeyEnv = {
	preview: "CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY",
	production: "CREATE_M10N_CONVEX_PRODUCTION_DEPLOY_KEY",
} as const;

export function createEnvSetupSecretProvider(
	env: Record<string, string | undefined> = process.env,
): SetupSecretProvider {
	return (request) => env[request.envName]?.trim() || undefined;
}

function completed(resourceRefs?: Record<string, string>): SetupApplyResult {
	return { status: "completed", resourceRefs };
}

function present(resourceRefs?: Record<string, string>): SetupCheckResult {
	return { status: "present", resourceRefs };
}

function missing(): SetupCheckResult {
	return { status: "missing" };
}

function blocked(message: string, nextAction?: string): SetupCheckResult {
	return {
		status: "blocked",
		failure: {
			kind: "blocker",
			message,
			nextAction,
		},
	};
}

function failed(kind: SetupStepFailure["kind"], message: string, nextAction?: string): SetupApplyResult {
	return {
		status: kind === "blocker" ? "blocked" : "failed",
		failure: {
			kind,
			message,
			nextAction,
		},
	};
}

async function shell(): Promise<BunShell> {
	const { $ } = await import("bun");
	return $;
}

async function run(
	strings: TemplateStringsArray,
	...values: unknown[]
): Promise<CommandResult> {
	try {
		const $ = await shell();
		const output = await $(strings, ...values).quiet();
		return {
			ok: true,
			stdout: await output.text(),
			stderr: "",
		};
	} catch (error) {
		const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
		return {
			ok: false,
			stdout: failure.stdout?.toString() ?? "",
			stderr: failure.stderr?.toString() ?? failure.message ?? "",
		};
	}
}

function runIn(cwd: string) {
	return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<CommandResult> => {
		try {
			const $ = await shell();
			const output = await $(strings, ...values).cwd(cwd).quiet();
			return {
				ok: true,
				stdout: await output.text(),
				stderr: "",
			};
		} catch (error) {
			const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
			return {
				ok: false,
				stdout: failure.stdout?.toString() ?? "",
				stderr: failure.stderr?.toString() ?? failure.message ?? "",
			};
		}
	};
}

function runWithStdin(cwd: string, value: string) {
	return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<CommandResult> => {
		try {
			const $ = await shell();
			const output = await $(strings, ...values).cwd(cwd).stdin(value).quiet();
			return {
				ok: true,
				stdout: await output.text(),
				stderr: "",
			};
		} catch (error) {
			const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
			return {
				ok: false,
				stdout: failure.stdout?.toString() ?? "",
				stderr: failure.stderr?.toString() ?? failure.message ?? "",
			};
		}
	};
}

async function promptSecret(question: string): Promise<string> {
	process.stdout.write(question);
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
		const value = Buffer.concat(chunks).toString("utf8");
		if (value.includes("\n")) return value.trim();
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

function resultFailure(result: CommandResult, action: string): SetupApplyResult {
	return failed(
		"retryable",
		`${action} failed: ${redact(result.stderr || result.stdout || "unknown error")}`,
		"Fix the command failure and rerun with --resume.",
	);
}

function checkFailure(result: CommandResult): SetupCheckResult {
	if (result.ok) return present();
	return missing();
}

export class LocalAdapter implements SetupAdapter {
	constructor(private readonly ctx: AdapterContext) {}

	async check(step: SetupStep): Promise<SetupCheckResult> {
		switch (step.action) {
			case "check-tools":
				return this.checkTools(step);
			case "check-scopes":
				return present();
			case "write-files":
				return existsSync(join(this.ctx.projectPath, "package.json")) ? present() : missing();
			case "bun-install":
				return existsSync(join(this.ctx.projectPath, "node_modules")) ? present() : missing();
			case "verify-local":
				return missing();
			default:
				return missing();
		}
	}

	async apply(step: SetupStep): Promise<SetupApplyResult> {
		switch (step.action) {
			case "check-tools":
			case "check-scopes":
				return completed();
			case "write-files":
				await writeGeneratedFiles(this.ctx.projectPath, this.ctx.project.files);
				return completed();
			case "bun-install": {
				const result = await runIn(this.ctx.projectPath)`bun install`;
				return result.ok ? completed() : resultFailure(result, "bun install");
			}
			case "verify-local": {
				const result = await runIn(this.ctx.projectPath)`bun run check`;
				return result.ok ? completed() : resultFailure(result, "local verification");
			}
			default:
				return completed();
		}
	}

	async verify(step: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return this.check(step);
	}

	redact(value: unknown): unknown {
		return redact(value);
	}

	private async checkTools(step: SetupStep): Promise<SetupCheckResult> {
		if (this.ctx.skipChecks) return present();
		const tools = (step.metadata?.tools as string[] | undefined) ?? [];
		const checks = await Promise.all(
			tools.map(async (tool) => {
				if (tool === "convex") return [tool, (await run`bunx convex --version`).ok] as const;
				if (tool === "vercel") return [tool, (await run`bunx vercel --version`).ok] as const;
				return [tool, (await run`which ${tool}`).ok] as const;
			}),
		);
		const missingTools = checks.filter(([, ok]) => !ok).map(([tool]) => tool);
		if (missingTools.length > 0) {
			return blocked(
				`Missing required tools: ${missingTools.join(", ")}`,
				"Install the missing tools or rerun with --skip-checks only if you know they are available later.",
			);
		}
		return present();
	}
}

export class GitAdapter implements SetupAdapter {
	constructor(private readonly ctx: AdapterContext) {}

	async check(): Promise<SetupCheckResult> {
		if (!existsSync(join(this.ctx.projectPath, ".git"))) return missing();
		const result = await runIn(this.ctx.projectPath)`git rev-parse --verify HEAD`;
		return checkFailure(result);
	}

	async apply(): Promise<SetupApplyResult> {
		for (const command of [
			["git init", () => runIn(this.ctx.projectPath)`git init`],
			["git add", () => runIn(this.ctx.projectPath)`git add .`],
			["git commit", () => runIn(this.ctx.projectPath)`git commit -m ${"Initial commit from create-m10n"}`],
		] as const) {
			const result = await command[1]();
			if (!result.ok) return resultFailure(result, command[0]);
		}
		return completed();
	}

	async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return this.check();
	}

	redact(value: unknown): unknown {
		return redact(value);
	}
}

export class GithubAdapter implements SetupAdapter {
	constructor(private readonly ctx: AdapterContext) {}

	async check(): Promise<SetupCheckResult> {
		const repo = this.repoFullName();
		const view = await runIn(this.ctx.projectPath)`gh repo view ${repo} --json nameWithOwner --jq .nameWithOwner`;
		if (!view.ok) return missing();
		const remote = await runIn(this.ctx.projectPath)`git remote get-url origin`;
		return present({
			repository: view.stdout.trim(),
			remote: remote.ok ? remote.stdout.trim() : "",
		});
	}

	async apply(): Promise<SetupApplyResult> {
		const visibility = this.ctx.context.visibility === "public" ? "--public" : "--private";
		const repo = this.repoFullName();
		const create = await runIn(this.ctx.projectPath)`gh repo create ${repo} ${visibility} --source=. --remote=origin`;
		if (!create.ok) {
			return {
				...resultFailure(create, "GitHub repository creation"),
				resourceRefs: { repository: repo },
			};
		}

		const remote = await runIn(this.ctx.projectPath)`git remote set-url origin ${`https://github.com/${repo}.git`}`;
		if (!remote.ok) {
			return {
				...resultFailure(remote, "GitHub remote configuration"),
				resourceRefs: { repository: repo },
			};
		}

		const push = await runIn(this.ctx.projectPath)`git push -u origin HEAD`;
		if (!push.ok) {
			return {
				...resultFailure(push, "GitHub repository push"),
				resourceRefs: { repository: repo },
			};
		}

		return completed({ repository: repo });
	}

	async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return this.check();
	}

	redact(value: unknown): unknown {
		return redact(value);
	}

	private repoFullName(): string {
		return this.ctx.context.githubOwner
			? `${this.ctx.context.githubOwner}/${this.ctx.context.projectSlug}`
			: this.ctx.context.projectSlug;
	}
}

export class ConvexAdapter implements SetupAdapter {
	constructor(private readonly ctx: AdapterContext) {}

	async check(step: SetupStep, state: SetupState): Promise<SetupCheckResult> {
		switch (step.action) {
			case "init-project":
				return existsSync(join(this.ctx.projectPath, ".env.local")) ? present() : missing();
			case "authkit-configure":
				return blocked(
					"WorkOS/AuthKit provisioning may require provider consent or dashboard setup.",
					"Complete the Convex AuthKit setup, then rerun with --resume.",
				);
			case "deploy-key-preview":
			case "deploy-key-production": {
				const stateKey = step.action === "deploy-key-preview" ? "deployKeyPreviewSet" : "deployKeyProductionSet";
				return Object.values(state.steps).some((entry) => entry.resourceRefs?.[stateKey] === "true")
					? present({ [stateKey]: "true" })
					: missing();
			}
			default:
				return missing();
		}
	}

	async apply(step: SetupStep, input: { interactive: boolean }): Promise<SetupApplyResult> {
		switch (step.action) {
			case "init-project": {
				const teamArgs = this.ctx.context.convexTeam ? ["--team", this.ctx.context.convexTeam] : [];
				const result = await runIn(this.ctx.projectPath)`bunx convex dev --once --configure new --project ${this.ctx.context.projectSlug} --dev-deployment cloud ${teamArgs}`;
				return result.ok ? completed() : resultFailure(result, "Convex initialization");
			}
			case "deploy-key-preview":
			case "deploy-key-production":
				return this.applyDeployKey(step, input.interactive);
			case "authkit-configure":
				return failed(
					"blocker",
					"WorkOS/AuthKit provisioning may require provider consent or dashboard setup.",
					"Complete the Convex AuthKit setup, then rerun with --resume.",
				);
			default:
				return completed();
		}
	}

	async verify(step: SetupStep, result: SetupApplyResult, state?: SetupState): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return present(result.resourceRefs);
	}

	redact(value: unknown): unknown {
		return redact(value);
	}

	private async applyDeployKey(step: SetupStep, interactive: boolean): Promise<SetupApplyResult> {
		const isPreview = step.action === "deploy-key-preview";
		const label = isPreview ? "Preview" : "Production";
		const envName = isPreview
			? convexDeployKeyEnv.preview
			: convexDeployKeyEnv.production;
		const providedKey = await this.ctx.secretProvider?.({
			provider: "convex",
			name: isPreview ? "previewDeployKey" : "productionDeployKey",
			envName,
		});

		if (!providedKey && !interactive) {
			return failed(
				"blocker",
				`Convex ${label} deploy key is required and cannot be generated headlessly.`,
				`Set ${envName} or create a Convex ${label} deploy key, then rerun without --no-interactive to enter it.`,
			);
		}

		const key = providedKey ?? await promptSecret(`Paste Convex ${label} deploy key: `);
		if (!key) {
			return failed("blocker", `No Convex ${label} deploy key provided.`, "Rerun with --resume to enter it.");
		}
		if (isPreview && key.startsWith("prod:")) {
			return failed("blocker", "A production deploy key was provided for preview.", "Create a Preview deploy key and rerun with --resume.");
		}
		if (!isPreview && key.startsWith("dev:")) {
			return failed("blocker", "A development deploy key was provided for production.", "Create a Production deploy key and rerun with --resume.");
		}

		const target = isPreview ? "preview" : "production";
		const runStdin = this.ctx.commands?.runWithStdin ?? runWithStdin;
		const result = await runStdin(
			this.ctx.projectPath,
			key,
		)`bunx vercel env add CONVEX_DEPLOY_KEY ${target} --force --sensitive`;
		if (!result.ok) return resultFailure(result, `Vercel ${target} CONVEX_DEPLOY_KEY setup`);
		return completed({ [isPreview ? "deployKeyPreviewSet" : "deployKeyProductionSet"]: "true" });
	}
}

export class VercelAdapter implements SetupAdapter {
	constructor(private readonly ctx: AdapterContext) {}

	async check(step: SetupStep): Promise<SetupCheckResult> {
		switch (step.action) {
			case "create-product-project":
			case "create-marketing-project": {
				const name = String(step.metadata?.projectName ?? "");
				const result = await this.vercelApi("GET", `/v9/projects/${name}`);
				return result.ok ? present({ project: name }) : missing();
			}
			case "set-product-env":
			case "set-marketing-env":
			case "deploy-product-preview":
			case "deploy-marketing-preview":
			case "deploy-product-production":
			case "deploy-marketing-production":
			case "verify-cloud":
				return missing();
			default:
				return missing();
		}
	}

	async apply(step: SetupStep): Promise<SetupApplyResult> {
		switch (step.action) {
			case "create-product-project":
			case "create-marketing-project":
				return this.createProject(step);
			case "set-product-env":
				return completed();
			case "set-marketing-env":
				return this.setMarketingEnv();
			case "deploy-product-preview":
				return this.deployProject(this.ctx.context.projectSlug, false);
			case "deploy-marketing-preview":
				return this.deployProject(`${this.ctx.context.projectSlug}-marketing`, false);
			case "deploy-product-production":
				return this.deployProject(this.ctx.context.projectSlug, true);
			case "deploy-marketing-production":
				return this.deployProject(`${this.ctx.context.projectSlug}-marketing`, true);
			case "verify-cloud":
				return completed();
			default:
				return completed();
		}
	}

	async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return present(result.resourceRefs);
	}

	redact(value: unknown): unknown {
		return redact(value);
	}

	private async createProject(step: SetupStep): Promise<SetupApplyResult> {
		const name = String(step.metadata?.projectName ?? "");
		const outputDirectory = String(step.metadata?.outputDirectory ?? "");
		const body = JSON.stringify({
			name,
			framework: "vite",
			gitRepository: {
				type: "github",
				repo: this.ctx.context.githubOwner
					? `${this.ctx.context.githubOwner}/${this.ctx.context.projectSlug}`
					: this.ctx.context.projectSlug,
			},
			buildCommand:
				step.action === "create-product-project"
					? "bunx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'bun run build:web'"
					: "bun run build:marketing",
			installCommand: "bun install",
			outputDirectory,
		});
		const result = await this.vercelApi("POST", "/v9/projects", body);
		return result.ok ? completed({ project: name }) : resultFailure(result, `Vercel project ${name} creation`);
	}

	private async setMarketingEnv(): Promise<SetupApplyResult> {
		const productDomain = `${this.ctx.context.projectSlug}.vercel.app`;
		const result = await runWithStdin(
			this.ctx.projectPath,
			`https://${productDomain}`,
		)`bunx vercel env add VITE_APP_URL preview production development --force`;
		return result.ok ? completed({ VITE_APP_URL: productDomain }) : resultFailure(result, "Marketing VITE_APP_URL setup");
	}

	private async deployProject(project: string, production: boolean): Promise<SetupApplyResult> {
		const prodArgs = production ? ["--prod"] : [];
		const result = await runIn(this.ctx.projectPath)`bunx vercel deploy --yes --project ${project} ${prodArgs}`;
		const target = production ? "production" : "preview";
		return result.ok ? completed({ deploymentUrl: result.stdout.trim() }) : resultFailure(result, `Vercel ${target} deploy for ${project}`);
	}

	private vercelApi(method: "GET" | "POST", path: string, body?: string): Promise<CommandResult> {
		const scopeArgs = this.ctx.context.vercelScope ? ["--scope", this.ctx.context.vercelScope] : [];
		return body
			? runIn(this.ctx.projectPath)`bunx vercel api ${method} ${path} --body ${body} ${scopeArgs}`
			: runIn(this.ctx.projectPath)`bunx vercel api ${method} ${path} ${scopeArgs}`;
	}
}

export function createSetupAdapters(ctx: AdapterContext): Record<string, SetupAdapter> {
	const local = new LocalAdapter(ctx);
	return {
		default: local,
		local,
		git: new GitAdapter(ctx),
		github: new GithubAdapter(ctx),
		convex: new ConvexAdapter(ctx),
		vercel: new VercelAdapter(ctx),
		...ctx.overrides,
	};
}
