import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import {
	createEnvSetupSecretProvider,
	createSetupAdapters,
} from "../src/adapters";
import { createContext, parseArgs } from "../src/cli";
import { toJson, writeGeneratedFiles } from "../src/files";
import { getRecipe } from "../src/recipes";
import {
	createInitialState,
	executeSetupPlan,
	redact,
	setupManifest,
	statePath,
} from "../src/setup";
import type {
	CreateContext,
	SetupAdapter,
	SetupApplyResult,
	SetupCheckResult,
	SetupState,
	SetupStep,
} from "../src/types";

const gateEnv = "CREATE_M10N_LIVE_SMOKE";
const timeoutMs = 120_000;

type CommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

type CleanupManifest = {
	version: 1;
	slug: string;
	recipe: "vite-spa-convex";
	startedAt: string;
	finishedAt?: string;
	localPath: string;
	manifestPath: string;
	resources: {
		github?: {
			mode?: "capability-check-only" | "created";
			owner?: string;
			repositoryCandidate?: string;
			authenticatedUser?: string;
			tokenScopes?: string;
			repository?: string;
			url?: string;
		};
		convex?: {
			deployment?: string;
			url?: string;
			manualCleanup: string;
		};
	};
	verification: Record<string, boolean | string>;
	cleanup: {
		githubRepo: "pending" | "not-created" | "deleted" | "failed" | "manual";
		tempDir: "pending" | "deleted" | "failed" | "kept";
		convex: "manual";
		errors: string[];
	};
	status: "pending" | "passed" | "failed";
	error?: unknown;
};

export function assertLiveSmokeEnabled(
	env: Record<string, string | undefined> = process.env,
): void {
	if (env[gateEnv] !== "1") {
		throw new Error(`Refusing to run live smoke. Set ${gateEnv}=1 to allow provider mutations.`);
	}
}

export function createDisposableSlug(
	date = new Date(),
	randomSuffix = randomBytes(3).toString("hex"),
): string {
	const stamp = date.toISOString().slice(0, 10).replaceAll("-", "");
	return `m10n-smoke-${stamp}-${randomSuffix}`;
}

export function createCleanupManifest(slug: string, localPath: string): CleanupManifest {
	const manifestPath = join("/tmp", `${slug}.cleanup.json`);
	return {
		version: 1,
		slug,
		recipe: "vite-spa-convex",
		startedAt: new Date().toISOString(),
		localPath,
		manifestPath,
		resources: {
			convex: {
				manualCleanup: `Delete the Convex project/deployment named ${slug} from the Convex dashboard after reviewing this smoke run.`,
			},
		},
		verification: {},
		cleanup: {
			githubRepo: "pending",
			tempDir: "pending",
			convex: "manual",
			errors: [],
		},
		status: "pending",
	};
}

export function stateContainsSecret(
	stateText: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const candidates = [
		env.CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY,
		env.CREATE_M10N_CONVEX_PRODUCTION_DEPLOY_KEY,
	].filter((value): value is string => Boolean(value));
	return candidates.some((secret) => stateText.includes(secret));
}

async function main(): Promise<void> {
	assertLiveSmokeEnabled();
	configureSmokeGitIdentity();
	const slug = createDisposableSlug();
	const localPath = resolve("/tmp", slug);
	const manifest = createCleanupManifest(slug, localPath);
	await writeManifest(manifest);

	let thrown: unknown;
	try {
		await runSmoke(slug, localPath, manifest);
		manifest.status = "passed";
	} catch (error) {
		thrown = error;
		manifest.status = "failed";
		manifest.error = publicErrorMessage(error);
	} finally {
		await cleanup(manifest);
		manifest.finishedAt = new Date().toISOString();
		await writeManifest(manifest);
		console.log(`Live smoke cleanup manifest: ${manifest.manifestPath}`);
	}

	if (thrown) throw thrown;
}

function configureSmokeGitIdentity(): void {
	process.env.GIT_AUTHOR_NAME ??= "create-m10n live smoke";
	process.env.GIT_AUTHOR_EMAIL ??= "create-m10n-smoke@example.invalid";
	process.env.GIT_COMMITTER_NAME ??= process.env.GIT_AUTHOR_NAME;
	process.env.GIT_COMMITTER_EMAIL ??= process.env.GIT_AUTHOR_EMAIL;
}

async function runSmoke(
	slug: string,
	localPath: string,
	manifest: CleanupManifest,
): Promise<void> {
	const owner = process.env.CREATE_M10N_GITHUB_OWNER;
	const convexTeam = process.env.CREATE_M10N_CONVEX_TEAM;
	const args = [
		slug,
		"--recipe",
		"vite-spa-convex",
		"--setup",
		"--no-interactive",
		"--visibility",
		"private",
		...(owner ? ["--github-owner", owner] : []),
		...(convexTeam ? ["--convex-team", convexTeam] : []),
	];
	const options = parseArgs(args);
	const context = createContext(options);
	const recipe = getRecipe(options.recipe);
	const project = recipe.create(context);
	const plan = recipe.planSetup(context);

	if (existsSync(localPath)) {
		throw new Error(`Disposable path already exists: ${localPath}`);
	}

	await writeGeneratedFiles(localPath, project.files);
	await writeFile(join(localPath, "setup.manifest.json"), toJson(setupManifest(plan)));

	const state = await executeSetupPlan({
		plan,
		projectPath: localPath,
		initialState: createInitialState(plan),
		interactive: false,
		adapters: createSetupAdapters({
			projectPath: localPath,
			context,
			project,
			skipChecks: false,
			secretProvider: createEnvSetupSecretProvider(),
			overrides: {
				github: new SmokeGithubCapabilityAdapter(context),
			},
		}),
		onStep(step, result) {
			console.log(`[live-smoke] ${step.id}: ${result.status}`);
		},
	});

	await discoverResources(localPath, manifest, state);
	await verifySmoke(localPath, manifest, state);
	await writeManifest(manifest);
}

async function discoverResources(
	localPath: string,
	manifest: CleanupManifest,
	state: SetupState,
): Promise<void> {
	const githubRefs = state.steps["github.repo"]?.resourceRefs;
	if (githubRefs) {
		manifest.resources.github = {
			mode: githubRefs.mode === "created" ? "created" : "capability-check-only",
			owner: githubRefs.owner,
			repositoryCandidate: githubRefs.repositoryCandidate,
			authenticatedUser: githubRefs.authenticatedUser,
			tokenScopes: githubRefs.tokenScopes,
			repository: githubRefs.repository,
		};
	}

	if (existsSync(join(localPath, ".env.local"))) {
		const envText = await readFile(join(localPath, ".env.local"), "utf8");
		const deployment = envText.match(/^CONVEX_DEPLOYMENT=(.+)$/m)?.[1];
		const url = envText.match(/^VITE_CONVEX_URL=(.+)$/m)?.[1];
		manifest.resources.convex = {
			deployment,
			url,
			manualCleanup: `Delete the Convex project/deployment named ${manifest.slug} from the Convex dashboard. This script does not run destructive Convex cleanup.`,
		};
	}
}

async function verifySmoke(
	localPath: string,
	manifest: CleanupManifest,
	state: SetupState,
): Promise<void> {
	const statuses = Object.values(state.steps).map((step) => step.status);
	const completed = statuses.every((status) => status === "completed" || status === "skipped");
	manifest.verification.setupStateCompleted = completed;

	const githubCandidate = manifest.resources.github?.repositoryCandidate;
	if (githubCandidate) {
		const view = await runCommand(["gh", "repo", "view", githubCandidate, "--json", "nameWithOwner"], {
			cwd: localPath,
		});
		manifest.verification.githubCapabilityChecked =
			manifest.resources.github?.mode === "capability-check-only";
		manifest.verification.githubRepoNotCreated = !view.ok;
	}

	const envPath = join(localPath, ".env.local");
	const envText = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
	manifest.verification.convexEnvHasUrl = /^VITE_CONVEX_URL=https?:\/\/.+/m.test(envText);

	const stateText = await readFile(statePath(localPath), "utf8");
	manifest.verification.setupStateHasNoDeployKey = !stateContainsSecret(stateText);
	manifest.verification.verifyLocalCompleted =
		state.steps["verify.local"]?.status === "completed";

	const failed = Object.entries(manifest.verification)
		.filter(([, value]) => value === false)
		.map(([key]) => key);
	if (failed.length > 0) {
		throw new Error(`Live smoke verification failed: ${failed.join(", ")}`);
	}
}

async function cleanup(manifest: CleanupManifest): Promise<void> {
	const repo = manifest.resources.github?.mode === "created"
		? manifest.resources.github.repository
		: undefined;
	if (repo && slugSafeForCleanup(repo, manifest.slug)) {
		const deleted = await runCommand(["gh", "repo", "delete", repo, "--yes"]);
		manifest.cleanup.githubRepo = deleted.ok ? "deleted" : "failed";
		if (!deleted.ok) {
			manifest.cleanup.errors.push(`GitHub cleanup failed: ${deleted.stderr || deleted.stdout}`);
		}
	} else {
		manifest.cleanup.githubRepo = repo ? "manual" : "not-created";
	}

	try {
		await rm(manifest.localPath, { recursive: true, force: true });
		manifest.cleanup.tempDir = "deleted";
	} catch (error) {
		manifest.cleanup.tempDir = "failed";
		manifest.cleanup.errors.push(String(redact(error)));
	}
}

class SmokeGithubCapabilityAdapter implements SetupAdapter {
	constructor(private readonly context: CreateContext) {}

	async check(): Promise<SetupCheckResult> {
		return { status: "missing" };
	}

	async apply(): Promise<SetupApplyResult> {
		const auth = await runCommand(["gh", "auth", "status"]);
		if (!auth.ok) {
			return failedResult(
				"GitHub CLI is not authenticated.",
				"Run gh auth login, then rerun the live smoke.",
			);
		}

		const user = await runCommand(["gh", "api", "user", "--jq", ".login"]);
		if (!user.ok) {
			return failedResult(
				"Could not read the authenticated GitHub user.",
				"Check gh auth status and rerun the live smoke.",
			);
		}

		const owner = this.context.githubOwner ?? user.stdout.trim();
		const ownerLookup = await runCommand(["gh", "api", `users/${owner}`, "--jq", ".login"]);
		if (!ownerLookup.ok) {
			return failedResult(
				`GitHub owner "${owner}" is not visible to the active token.`,
				"Use CREATE_M10N_GITHUB_OWNER for an accessible user or organization.",
			);
		}

		const scopes = auth.stdout.match(/Token scopes: '([^']+)'/)?.[1] ?? "";
		if (!scopes.split(/,\s*/).includes("repo")) {
			return failedResult(
				"GitHub token does not report the repo scope required for private repository creation.",
				"Refresh gh auth with repo scope or use an account that already has it.",
			);
		}

		const repositoryCandidate = `${owner}/${this.context.projectSlug}`;
		const existing = await runCommand(["gh", "repo", "view", repositoryCandidate, "--json", "nameWithOwner"]);
		if (existing.ok) {
			return failedResult(
				`Disposable GitHub repository candidate already exists: ${repositoryCandidate}`,
				"Delete the existing disposable repository or rerun with a fresh smoke slug.",
			);
		}

		return {
			status: "completed",
			resourceRefs: {
				mode: "capability-check-only",
				owner,
				repositoryCandidate,
				authenticatedUser: user.stdout.trim(),
				tokenScopes: scopes,
			},
		};
	}

	async verify(_: SetupStep, result: SetupApplyResult): Promise<SetupCheckResult> {
		if (result.status !== "completed") return { status: "blocked", failure: result.failure };
		return { status: "present", resourceRefs: result.resourceRefs };
	}

	redact(value: unknown): unknown {
		return redact(value);
	}
}

function failedResult(message: string, nextAction: string): SetupApplyResult {
	return {
		status: "failed",
		failure: {
			kind: "retryable",
			message,
			nextAction,
		},
	};
}

function slugSafeForCleanup(repo: string, slug: string): boolean {
	const repoName = repo.split("/").at(-1);
	return slug.startsWith("m10n-smoke-") && repoName === slug;
}

async function writeManifest(manifest: CleanupManifest): Promise<void> {
	await writeFile(manifest.manifestPath, toJson(redact(manifest)));
}

async function runCommand(
	args: string[],
	options: { cwd?: string; stdin?: string } = {},
): Promise<CommandResult> {
	const proc = Bun.spawn(args, {
		cwd: options.cwd,
		stdin: options.stdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (options.stdin && proc.stdin) {
		proc.stdin.write(options.stdin);
		proc.stdin.end();
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);

	return {
		ok: exitCode === 0 && !timedOut,
		stdout,
		stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr,
	};
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(publicErrorMessage(error));
		process.exit(1);
	});
}

function publicErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes(gateEnv)) return message;
	return String(redact(message));
}
