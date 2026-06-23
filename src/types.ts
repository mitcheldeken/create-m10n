export type RecipeId = "micro-saas" | "vite-spa-convex";
export type AuthAdapter = "workos" | "none";
export type BillingMode = "shell" | "none";
export type DeployAdapter = "vercel" | "none";
export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export type ProjectShape = "monorepo" | "standalone";

export interface CliOptions {
	projectName?: string;
	recipe: RecipeId;
	auth: AuthAdapter;
	billing: BillingMode;
	deploy: DeployAdapter;
	packageManager: PackageManager;
	shape: ProjectShape;
	dryRun: boolean;
	setup: boolean;
	resume: boolean;
	planJson: boolean;
	install: boolean;
	git: boolean;
	list: boolean;
	noInteractive: boolean;
	noPreview: boolean;
	production: boolean;
	skipChecks: boolean;
	showHelp: boolean;
	profile?: string;
	githubOwner?: string;
	vercelScope?: string;
	convexTeam?: string;
	visibility: "private" | "public";
	updateLock?: RecipeId;
}

export interface CreateContext {
	projectName: string;
	projectSlug: string;
	packageScope: string;
	auth: AuthAdapter;
	billing: BillingMode;
	deploy: DeployAdapter;
	packageManager: PackageManager;
	shape: ProjectShape;
	githubOwner?: string;
	vercelScope?: string;
	convexTeam?: string;
	visibility: "private" | "public";
	noPreview: boolean;
	production: boolean;
}

export interface GeneratedFile {
	path: string;
	contents: string;
}

export interface GeneratedProject {
	files: GeneratedFile[];
	nextSteps: string[];
	verification: string[];
}

export type SetupFailureKind = "retryable" | "blocker" | "fatal";
export type SetupStepKind =
	| "preflight"
	| "generate"
	| "install"
	| "git"
	| "github"
	| "convex"
	| "auth"
	| "vercel"
	| "env"
	| "deploy"
	| "verify";

export interface SetupStep {
	id: string;
	title: string;
	kind: SetupStepKind;
	dependsOn: string[];
	adapter: string;
	action: string;
	blocker?: {
		reason: string;
		nextAction: string;
	};
	metadata?: Record<string, unknown>;
}

export interface SetupPlan {
	version: 1;
	recipe: RecipeId;
	project: {
		name: string;
		slug: string;
		packageScope: string;
	};
	options: {
		auth: AuthAdapter;
		billing: BillingMode;
		deploy: DeployAdapter;
		packageManager: PackageManager;
		shape: ProjectShape;
		visibility: "private" | "public";
		noPreview: boolean;
		production: boolean;
	};
	scopes: {
		githubOwner?: string;
		vercelScope?: string;
		convexTeam?: string;
	};
	steps: SetupStep[];
}

export interface SetupStepFailure {
	kind: SetupFailureKind;
	message: string;
	nextAction?: string;
}

export interface SetupStepState {
	status: "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
	attempts: number;
	resourceRefs?: Record<string, string>;
	checkedAt?: string;
	completedAt?: string;
	failure?: SetupStepFailure;
}

export interface SetupState {
	version: 1;
	projectSlug: string;
	recipe: RecipeId;
	contextHash: string;
	updatedAt: string;
	steps: Record<string, SetupStepState>;
}

export interface SetupCheckResult {
	status: "missing" | "present" | "blocked";
	resourceRefs?: Record<string, string>;
	failure?: SetupStepFailure;
}

export interface SetupApplyResult {
	status: "completed" | "blocked" | "failed" | "skipped";
	resourceRefs?: Record<string, string>;
	failure?: SetupStepFailure;
}

export interface SetupAdapter {
	check: (step: SetupStep, state: SetupState) => Promise<SetupCheckResult>;
	apply: (step: SetupStep, input: { state: SetupState; interactive: boolean }) => Promise<SetupApplyResult>;
	verify: (step: SetupStep, result: SetupApplyResult) => Promise<SetupCheckResult>;
	redact: (value: unknown) => unknown;
}

export interface RecipeLock {
	version: 1;
	recipe: RecipeId;
	updatedAt: string;
	pins: Record<string, string>;
	notes: string[];
}

export interface RecipeManifest {
	id: RecipeId;
	title: string;
	description: string;
	defaults: {
		auth: AuthAdapter;
		billing: BillingMode;
		deploy: DeployAdapter;
		packageManager: PackageManager;
		shape: ProjectShape;
	};
	supported: {
		auth: AuthAdapter[];
		billing: BillingMode[];
		deploy: DeployAdapter[];
		packageManagers: PackageManager[];
		shapes: ProjectShape[];
	};
	vitePlus: {
		templateName: string;
		description: string;
		monorepo: boolean;
	};
	lock: RecipeLock;
	create: (context: CreateContext) => GeneratedProject;
	planSetup: (context: CreateContext) => SetupPlan;
}
