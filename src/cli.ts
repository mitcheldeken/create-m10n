import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { createSetupAdapters } from "./adapters";
import { c, colors } from "./colors";
import { listGeneratedFiles, toJson, writeGeneratedFiles } from "./files";
import { getRecipe, recipeIds, recipes } from "./recipes";
import {
	createInitialState,
	executeSetupPlan,
	readSetupState,
	setupManifest,
	statePath,
} from "./setup";
import type {
	AuthAdapter,
	BillingMode,
	CliOptions,
	CreateContext,
	DeployAdapter,
	PackageManager,
	ProjectShape,
	RecipeId,
	RecipeManifest,
} from "./types";

type RawOptions = {
	projectName?: string;
	recipe?: string;
	auth?: string;
	billing?: string;
	deploy?: string;
	packageManager?: string;
	shape?: string;
	dryRun?: boolean;
	setup?: boolean;
	resume?: boolean;
	planJson?: boolean;
	install?: boolean;
	git?: boolean;
	list?: boolean;
	noInteractive?: boolean;
	noPreview?: boolean;
	production?: boolean;
	skipChecks?: boolean;
	showHelp?: boolean;
	profile?: string;
	githubOwner?: string;
	vercelScope?: string;
	convexTeam?: string;
	visibility?: string;
	updateLock?: string;
};

const booleanFlags = new Map<string, keyof RawOptions>([
	["--dry-run", "dryRun"],
	["--setup", "setup"],
	["--resume", "resume"],
	["--plan-json", "planJson"],
	["--install", "install"],
	["--git", "git"],
	["--list", "list"],
	["--no-interactive", "noInteractive"],
	["--no-preview", "noPreview"],
	["--production", "production"],
	["--skip-checks", "skipChecks"],
	["-s", "skipChecks"],
	["--help", "showHelp"],
	["-h", "showHelp"],
]);

const valueFlags = new Map<string, keyof RawOptions>([
	["--recipe", "recipe"],
	["--auth", "auth"],
	["--billing", "billing"],
	["--deploy", "deploy"],
	["--shape", "shape"],
	["--pm", "packageManager"],
	["--package-manager", "packageManager"],
	["--profile", "profile"],
	["--github-owner", "githubOwner"],
	["--vercel-scope", "vercelScope"],
	["--convex-team", "convexTeam"],
	["--visibility", "visibility"],
	["--update-lock", "updateLock"],
]);

type ProfileOptions = Partial<Pick<
	RawOptions,
	| "recipe"
	| "auth"
	| "billing"
	| "deploy"
	| "packageManager"
	| "shape"
	| "githubOwner"
	| "vercelScope"
	| "convexTeam"
	| "visibility"
	| "noPreview"
	| "production"
	| "noInteractive"
>>;

export function parseArgs(argv: string[], profile: ProfileOptions = {}): CliOptions {
	const raw = { ...profile, ...parseRawArgs(argv) };
	const recipe = normalizeRecipe(raw.recipe ?? raw.updateLock ?? "micro-saas");
	const manifest = getRecipe(recipe);
	const visibility = normalizeChoice(
		raw.visibility ?? "private",
		"visibility",
		["private", "public"] as const,
	);

	return {
		projectName: raw.projectName,
		recipe,
		auth: normalizeChoice(
			raw.auth ?? manifest.defaults.auth,
			"auth",
			manifest.supported.auth,
		),
		billing: normalizeChoice(
			raw.billing ?? manifest.defaults.billing,
			"billing",
			manifest.supported.billing,
		),
		deploy: normalizeChoice(
			raw.deploy ?? manifest.defaults.deploy,
			"deploy",
			manifest.supported.deploy,
		),
		packageManager: normalizeChoice(
			raw.packageManager ?? manifest.defaults.packageManager,
			"package manager",
			manifest.supported.packageManagers,
		),
		shape: normalizeChoice(
			raw.shape ?? manifest.defaults.shape,
			"shape",
			manifest.supported.shapes,
		),
		dryRun: raw.dryRun ?? false,
		setup: raw.setup ?? false,
		resume: raw.resume ?? false,
		planJson: raw.planJson ?? false,
		install: raw.install ?? false,
		git: raw.git ?? false,
		list: raw.list ?? false,
		noInteractive: raw.noInteractive ?? false,
		noPreview: raw.noPreview ?? false,
		production: raw.production ?? false,
		skipChecks: raw.skipChecks ?? false,
		showHelp: raw.showHelp ?? false,
		profile: raw.profile,
		githubOwner: raw.githubOwner,
		vercelScope: raw.vercelScope,
		convexTeam: raw.convexTeam,
		visibility,
		updateLock: raw.updateLock ? normalizeRecipe(raw.updateLock) : undefined,
	};
}

function parseRawArgs(argv: string[]): RawOptions {
	const raw: RawOptions = {};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const [maybeFlag, inlineValue] = arg.split("=", 2);

		if (booleanFlags.has(arg)) {
			setBooleanOption(raw, booleanFlags.get(arg)!);
			continue;
		}

		if (valueFlags.has(maybeFlag)) {
			const value = inlineValue ?? argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new Error(`${maybeFlag} requires a value.`);
			}
			setValueOption(raw, valueFlags.get(maybeFlag)!, value);
			if (inlineValue === undefined) index += 1;
			continue;
		}

		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}

		if (raw.projectName) {
			throw new Error(`Unexpected extra argument: ${arg}`);
		}

		raw.projectName = arg;
	}

	return raw;
}

function setBooleanOption(raw: RawOptions, key: keyof RawOptions): void {
	switch (key) {
		case "dryRun":
		case "setup":
		case "resume":
		case "planJson":
		case "install":
		case "git":
		case "list":
		case "noInteractive":
		case "noPreview":
		case "production":
		case "skipChecks":
		case "showHelp":
			raw[key] = true;
			return;
		default:
			throw new Error(`Internal parser error: ${String(key)} is not boolean.`);
	}
}

function setValueOption(
	raw: RawOptions,
	key: keyof RawOptions,
	value: string,
): void {
	switch (key) {
		case "recipe":
		case "auth":
		case "billing":
		case "deploy":
		case "packageManager":
		case "shape":
		case "profile":
		case "githubOwner":
		case "vercelScope":
		case "convexTeam":
		case "visibility":
		case "updateLock":
			raw[key] = value;
			return;
		default:
			throw new Error(`Internal parser error: ${String(key)} is not a value option.`);
	}
}

function normalizeRecipe(value: string): RecipeId {
	if (recipeIds().includes(value as RecipeId)) {
		return value as RecipeId;
	}

	throw new Error(
		`Unknown recipe "${value}". Available recipes: ${recipeIds().join(", ")}`,
	);
}

function normalizeChoice<const T extends string>(
	value: string,
	label: string,
	supported: readonly T[],
): T {
	if (supported.includes(value as T)) {
		return value as T;
	}

	throw new Error(
		`Unsupported ${label} "${value}". Supported values: ${supported.join(", ")}`,
	);
}

export function toProjectSlug(projectName: string): string {
	if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(projectName)) {
		throw new Error(
			"Invalid project name. Use letters, numbers, hyphens, or underscores, and start with a letter.",
		);
	}

	return projectName.toLowerCase().replaceAll("_", "-");
}

export function createContext(options: CliOptions): CreateContext {
	if (!options.projectName) {
		throw new Error("Project name is required.");
	}

	const projectSlug = toProjectSlug(options.projectName);
	return {
		projectName: options.projectName,
		projectSlug,
		packageScope: `@${projectSlug}`,
		auth: options.auth as AuthAdapter,
		billing: options.billing as BillingMode,
		deploy: options.deploy as DeployAdapter,
		packageManager: options.packageManager as PackageManager,
		shape: options.shape as ProjectShape,
		githubOwner: options.githubOwner,
		vercelScope: options.vercelScope,
		convexTeam: options.convexTeam,
		visibility: options.visibility,
		noPreview: options.noPreview,
		production: options.production,
	};
}

async function checkPrerequisites(options: CliOptions): Promise<void> {
	if (options.skipChecks || options.dryRun || options.planJson || options.list || options.showHelp) {
		return;
	}

	if (options.packageManager !== "bun") {
		return;
	}

	try {
		const { $ } = await import("bun");
		await $`bun --version`.quiet();
	} catch {
		throw new Error("Bun is required for the current recipes. Install Bun or rerun with --skip-checks.");
	}
}

function printHelp(): void {
	console.log(
		[
			"",
			`${colors.bold}create-m10n${colors.reset}`,
			"",
			"Deterministic, agent-native scaffolds for micro-SaaS projects.",
			"",
			`${colors.bold}Usage:${colors.reset}`,
			"  bunx create-m10n <project-name>",
			"  bunx create-m10n <project-name> --recipe vite-spa-convex",
			"",
			`${colors.bold}Defaults:${colors.reset}`,
			"  --recipe micro-saas --shape monorepo --auth workos --deploy vercel --billing shell --pm bun",
			"",
			`${colors.bold}Options:${colors.reset}`,
			"  --recipe <id>          micro-saas | vite-spa-convex",
			"  --auth <id>            workos | none",
			"  --deploy <id>          vercel | none",
			"  --billing <id>         shell | none",
			"  --shape <id>           monorepo | standalone",
			"  --pm <id>              bun",
			"  --dry-run              Print generated files without writing",
			"  --setup                Generate files and run the resumable setup DAG",
			"  --resume               Resume setup from .m10n/setup-state.json",
			"  --plan-json            Print the redacted setup DAG without writing files",
			"  --profile <file>       Load setup defaults from a JSON profile",
			"  --github-owner <owner> GitHub owner or organization for setup",
			"  --vercel-scope <team>  Vercel team or user scope for setup",
			"  --convex-team <team>   Convex team for setup",
			"  --visibility <value>   private | public (default private)",
			"  --no-interactive       Never prompt; write blocker state and exit non-zero",
			"  --no-preview           Skip preview deployment steps",
			"  --production           Allow production deployment steps when supported",
			"  --install              Run package installation after writing files",
			"  --git                  Initialize git and create the first commit",
			"  --list                 List available recipes",
			"  --update-lock <id>     Print the current lock metadata for a recipe",
			"  -s, --skip-checks      Skip local prerequisite checks",
			"  -h, --help             Show this help message",
			"",
		].join("\n"),
	);
}

function printRecipes(): void {
	console.log(c.header("Available Recipes"));
	for (const recipe of recipes) {
		console.log(`${colors.bold}${recipe.id}${colors.reset}`);
		console.log(`  ${recipe.description}`);
		console.log(`  defaults: ${formatDefaults(recipe)}`);
		console.log(
			`  vite+: ${recipe.vitePlus.templateName}${recipe.vitePlus.monorepo ? " (monorepo)" : ""}`,
		);
		console.log("");
	}
}

async function readProfile(path?: string): Promise<ProfileOptions> {
	if (!path) return {};
	const parsed = JSON.parse(await readFile(path, "utf8")) as ProfileOptions;
	const allowed = new Set([
		"recipe",
		"auth",
		"billing",
		"deploy",
		"packageManager",
		"shape",
		"githubOwner",
		"vercelScope",
		"convexTeam",
		"visibility",
		"noPreview",
		"production",
		"noInteractive",
	]);
	for (const key of Object.keys(parsed)) {
		if (!allowed.has(key)) {
			throw new Error(`Unsupported profile key: ${key}`);
		}
	}
	return parsed;
}

function printSetupPlanJson(recipe: RecipeManifest, context: CreateContext): void {
	console.log(toJson(recipe.planSetup(context)));
}

async function writeSetupManifest(projectPath: string, recipe: RecipeManifest, context: CreateContext): Promise<void> {
	await writeFile(
		resolve(projectPath, "setup.manifest.json"),
		toJson(setupManifest(recipe.planSetup(context))),
	);
}

function printBlockedState(projectPath: string): void {
	console.log(c.warning("Setup paused. A resumable state file was written."));
	console.log(`  State: ${statePath(projectPath)}`);
	console.log("  Resume: bunx create-m10n " + projectPath.split("/").at(-1) + " --resume");
}

async function runSetup(
	options: CliOptions,
	context: CreateContext,
	recipe: RecipeManifest,
	projectPath: string,
): Promise<void> {
	const project = recipe.create(context);
	const plan = recipe.planSetup(context);
	const existingState = await readSetupState(projectPath);

	if (!options.resume) {
		if (existsSync(projectPath)) {
			throw new Error(`Directory already exists: ${context.projectName}`);
		}
		console.log(c.header(`Creating ${recipe.title}`));
		console.log(c.info(`Writing ${project.files.length} files...`));
		await writeGeneratedFiles(projectPath, project.files);
		await writeSetupManifest(projectPath, recipe, context);
		console.log(c.success("Project files created"));
	}

	const state = await executeSetupPlan({
		plan,
		projectPath,
		initialState: existingState ?? createInitialState(plan),
		interactive: !options.noInteractive,
		adapters: createSetupAdapters({
			projectPath,
			context,
			project,
			skipChecks: options.skipChecks,
		}),
	});

	const blocked = Object.values(state.steps).find((step) => step.status === "blocked");
	if (blocked) {
		printBlockedState(projectPath);
		if (options.noInteractive) process.exit(1);
		return;
	}

	printComplete(projectPath, project);
}

function formatDefaults(recipe: RecipeManifest): string {
	return [
		`shape=${recipe.defaults.shape}`,
		`auth=${recipe.defaults.auth}`,
		`deploy=${recipe.defaults.deploy}`,
		`billing=${recipe.defaults.billing}`,
		`pm=${recipe.defaults.packageManager}`,
	].join(" ");
}

function printDryRun(
	options: CliOptions,
	context: CreateContext,
	recipe: RecipeManifest,
): void {
	const project = recipe.create(context);
	console.log(c.header("Dry Run"));
	console.log(`Project: ${context.projectName}`);
	console.log(`Recipe:  ${options.recipe}`);
	console.log(`Options: shape=${options.shape} auth=${options.auth} deploy=${options.deploy} billing=${options.billing}`);
	console.log("");
	console.log("Files:");
	for (const path of listGeneratedFiles(project.files)) {
		console.log(`  ${path}`);
	}
	console.log("");
	console.log("Next steps:");
	for (const step of project.nextSteps) {
		console.log(`  ${step}`);
	}
}

async function maybeInstall(options: CliOptions, projectPath: string): Promise<void> {
	if (!options.install) return;
	console.log(c.header("Installing Dependencies"));
	const { $ } = await import("bun");
	await $`bun install`.cwd(projectPath);
	console.log(c.success("Dependencies installed"));
}

async function maybeGit(options: CliOptions, projectPath: string): Promise<void> {
	if (!options.git) return;
	console.log(c.header("Initializing Git"));
	const { $ } = await import("bun");
	await $`git init`.cwd(projectPath);
	await $`git add .`.cwd(projectPath);
	await $`git commit -m "Initial commit from create-m10n"`.cwd(projectPath);
	console.log(c.success("Git repository initialized"));
}

function printComplete(projectPath: string, project: ReturnType<RecipeManifest["create"]>): void {
	console.log(c.header("Setup Complete"));
	console.log(`Project: ${projectPath}`);
	console.log("");
	console.log(`${colors.green}Next steps:${colors.reset}`);
	for (const step of project.nextSteps) {
		console.log(`  ${step}`);
	}
	console.log("");
	console.log(`${colors.green}Verification:${colors.reset}`);
	for (const step of project.verification) {
		console.log(`  ${step}`);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const raw = parseRawArgs(argv);
	const profile = await readProfile(raw.profile);
	const options = parseArgs(argv, profile);

	if (options.showHelp) {
		printHelp();
		return;
	}

	if (options.list) {
		printRecipes();
		return;
	}

	if (options.updateLock) {
		console.log(toJson(getRecipe(options.updateLock).lock));
		return;
	}

	if (!options.projectName) {
		printHelp();
		process.exit(1);
	}

	await checkPrerequisites(options);

	const context = createContext(options);
	const recipe = getRecipe(options.recipe);
	const project = recipe.create(context);
	const projectPath = resolve(process.cwd(), context.projectName);

	if (options.planJson) {
		printSetupPlanJson(recipe, context);
		return;
	}

	if (options.dryRun) {
		printDryRun(options, context, recipe);
		return;
	}

	if (options.setup || options.resume) {
		await runSetup(options, context, recipe, projectPath);
		return;
	}

	if (existsSync(projectPath)) {
		throw new Error(`Directory already exists: ${context.projectName}`);
	}

	console.log(c.header(`Creating ${recipe.title}`));
	console.log(c.info(`Writing ${project.files.length} files...`));
	await writeGeneratedFiles(projectPath, project.files);
	console.log(c.success("Project files created"));

	await maybeInstall(options, projectPath);
	await maybeGit(options, projectPath);

	printComplete(projectPath, project);
}
