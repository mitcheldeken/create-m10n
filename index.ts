#!/usr/bin/env bun
/**
 * create-m10n
 *
 * Creates a Convex + TanStack Start project configured for Vercel deployment.
 *
 * Usage:
 *   bunx create-m10n my-project
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";
import * as readline from "readline";

// Colors for terminal output
const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	bold: "\x1b[1m",
};

const c = {
	error: (msg: string) => `${colors.red}✗${colors.reset} ${msg}`,
	success: (msg: string) => `${colors.green}✓${colors.reset} ${msg}`,
	warning: (msg: string) => `${colors.yellow}⚠${colors.reset} ${msg}`,
	info: (msg: string) => `${colors.blue}▸${colors.reset} ${msg}`,
	header: (msg: string) =>
		`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n${colors.blue}  ${msg}${colors.reset}\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
};

// ============================================================================
// Utility Functions
// ============================================================================

async function prompt(question: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	try {
		const content = await Bun.file(filePath).text();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#")) {
				const eqIndex = trimmed.indexOf("=");
				if (eqIndex !== -1) {
					const key = trimmed.slice(0, eqIndex).trim();
					let value = trimmed.slice(eqIndex + 1).trim();
					// Remove quotes if present
					if (
						(value.startsWith('"') && value.endsWith('"')) ||
						(value.startsWith("'") && value.endsWith("'"))
					) {
						value = value.slice(1, -1);
					}
					env[key] = value;
				}
			}
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return env;
}

async function addVercelEnvVar(
	name: string,
	value: string,
	environments: string[],
): Promise<boolean> {
	try {
		for (const env of environments) {
			// Use echo to pipe the value to vercel env add
			await $`echo ${value} | bunx vercel env add ${name} ${env} --force`.quiet();
		}
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Prerequisite Checks
// ============================================================================

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await $`which ${cmd}`.quiet();
		return true;
	} catch {
		return false;
	}
}

async function checkBun(): Promise<{ ok: boolean; version?: string }> {
	try {
		const result = await $`bun --version`.text();
		return { ok: true, version: result.trim() };
	} catch {
		return { ok: false };
	}
}

async function checkGitHub(): Promise<{ ok: boolean; user?: string }> {
	try {
		await $`gh auth status`.quiet();
		const user = await $`gh api user --jq '.login'`.text();
		return { ok: true, user: user.trim() };
	} catch {
		return { ok: false };
	}
}

async function checkConvex(): Promise<{ ok: boolean }> {
	try {
		// Convex stores auth in ~/.convex/config.json
		const homeDir = process.env.HOME || process.env.USERPROFILE || "";
		const configPath = resolve(homeDir, ".convex", "config.json");

		if (!existsSync(configPath)) {
			return { ok: false };
		}

		const config = await Bun.file(configPath).json();
		if (config.accessToken) {
			return { ok: true };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

async function checkVercel(): Promise<{ ok: boolean; user?: string }> {
	try {
		if (await commandExists("vercel")) {
			const result = await $`vercel whoami`.text();
			return { ok: true, user: result.trim() };
		}
		const result = await $`bunx vercel whoami`.text();
		return { ok: true, user: result.trim() };
	} catch {
		return { ok: false };
	}
}

async function checkAllPrerequisites(): Promise<boolean> {
	console.log(c.header("Checking Prerequisites"));

	let allGood = true;

	// Check bun
	console.log(c.info("Checking bun..."));
	const bun = await checkBun();
	if (bun.ok) {
		console.log(c.success(`bun is installed (v${bun.version})`));
	} else {
		console.log(c.error("bun is not installed"));
		console.log(
			"\n  Install bun:\n    curl -fsSL https://bun.sh/install | bash\n",
		);
		allGood = false;
	}

	// Check GitHub CLI
	console.log(c.info("Checking GitHub CLI (gh)..."));
	const gh = await checkGitHub();
	if (gh.ok) {
		console.log(c.success(`GitHub CLI authenticated as: ${gh.user}`));
	} else {
		console.log(c.error("GitHub CLI not authenticated"));
		console.log("\n  To authenticate:\n    gh auth login\n");
		allGood = false;
	}

	// Check Convex CLI
	console.log(c.info("Checking Convex CLI..."));
	const convex = await checkConvex();
	if (convex.ok) {
		console.log(c.success("Convex CLI authenticated"));
	} else {
		console.log(c.error("Convex CLI not authenticated"));
		console.log("\n  To authenticate:\n    bunx convex login\n");
		allGood = false;
	}

	// Check Vercel CLI
	console.log(c.info("Checking Vercel CLI..."));
	const vercel = await checkVercel();
	if (vercel.ok) {
		console.log(c.success(`Vercel CLI authenticated as: ${vercel.user}`));
	} else {
		console.log(c.error("Vercel CLI not authenticated"));
		console.log("\n  To authenticate:\n    bunx vercel login\n");
		allGood = false;
	}

	console.log("");

	if (!allGood) {
		console.log(
			c.error("Some prerequisites are missing. Please fix them and run again."),
		);
	} else {
		console.log(c.success("All prerequisites satisfied!"));
	}

	return allGood;
}

// ============================================================================
// Project Setup
// ============================================================================

const VITE_CONFIG = `import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
})
`;

const VERCEL_JSON = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "bun install",
  "buildCommand": "bunx convex deploy --cmd 'bun run build'"
}
`;

async function createProject(projectName: string): Promise<void> {
	const projectPath = resolve(process.cwd(), projectName);

	if (existsSync(projectPath)) {
		console.log(c.error(`Directory '${projectName}' already exists.`));
		process.exit(1);
	}

	// Step 1: Create from Convex template
	console.log(c.header("Creating Project from Template"));
	console.log(c.info("Running create-convex with tanstack-start template..."));
	await $`bunx create-convex@latest ${projectName} -t tanstack-start`;
	console.log(c.success("Project created"));

	process.chdir(projectPath);

	// Step 2: Add Nitro
	console.log(c.header("Adding Nitro for Vercel"));
	console.log(c.info("Installing nitro-nightly..."));
	await $`bun add nitro@npm:nitro-nightly@latest`;
	console.log(c.success("Nitro installed"));

	// Step 3: Configure vite.config.ts
	console.log(c.header("Configuring Vite"));
	console.log(c.info("Adding Nitro plugin to vite.config.ts..."));
	await Bun.write("vite.config.ts", VITE_CONFIG);
	console.log(c.success("vite.config.ts configured"));

	// Step 4: Configure vercel.json
	console.log(c.header("Configuring Vercel"));
	console.log(c.info("Creating vercel.json..."));
	await Bun.write("vercel.json", VERCEL_JSON);
	console.log(c.success("vercel.json created"));

	// Step 5: Update package.json scripts
	console.log(c.header("Updating Scripts for Bun"));
	console.log(c.info("Patching package.json scripts..."));
	const pkg = await Bun.file("package.json").json();
	pkg.scripts.dev =
		"bunx convex dev --once && concurrently -r bun:dev:web bun:dev:convex";
	pkg.scripts["dev:convex"] = "bunx convex dev";
	pkg.scripts.start = "bun .output/server/index.mjs";
	await Bun.write("package.json", JSON.stringify(pkg, null, 2) + "\n");
	console.log(c.success("package.json updated"));

	// Step 6: Install dependencies
	console.log(c.header("Installing Dependencies"));
	console.log(c.info("Running bun install..."));
	await $`bun install`;
	console.log(c.success("Dependencies installed"));

	// Step 7: Initialize Git
	console.log(c.header("Initializing Git"));
	console.log(c.info("Initializing git repository..."));
	await $`git init`;
	await $`git add .`;
	await $`git commit -m "Initial commit: Convex + TanStack Start + Vercel"`;
	console.log(c.success("Git repository initialized"));

	// Step 8: Create GitHub repo
	console.log(c.header("Creating GitHub Repository"));
	console.log(c.info("Creating GitHub repository..."));
	try {
		await $`gh repo create ${projectName} --private --source=. --remote=origin --push`;
		console.log(c.success("GitHub repository created and pushed"));
	} catch {
		console.log(c.warning("Could not create GitHub repository automatically."));
		console.log(
			`  Run manually: gh repo create ${projectName} --private --source=. --remote=origin --push\n`,
		);
	}

	// Step 9: Initialize Convex
	console.log(c.header("Setting Up Convex"));
	console.log(c.info("Creating Convex project..."));
	let convexUrl = "";
	try {
		await $`bunx convex dev --once`;
		console.log(c.success("Convex project initialized"));

		// Read VITE_CONVEX_URL from .env.local
		const envVars = await readEnvFile(".env.local");
		convexUrl = envVars.VITE_CONVEX_URL || "";
		if (convexUrl) {
			console.log(c.success(`Found VITE_CONVEX_URL: ${convexUrl}`));
		}
	} catch {
		console.log(
			c.warning(
				"Could not initialize Convex automatically. Run: bunx convex dev\n",
			),
		);
	}

	// Step 10: Get Convex Deploy Key
	console.log(c.header("Convex Deploy Key"));
	console.log(c.info("A deploy key is required for Vercel deployments.\n"));
	console.log("  1. Go to: https://dashboard.convex.dev");
	console.log("  2. Select your project → Settings → Deploy Keys");
	console.log("  3. Create a new deploy key and copy it\n");

	const deployKey = await prompt(
		`${colors.yellow}?${colors.reset} Paste your Convex Deploy Key (or press Enter to skip): `,
	);

	// Step 11: Link to Vercel
	console.log(c.header("Setting Up Vercel"));
	console.log(c.info("Linking to Vercel..."));
	let vercelLinked = false;
	try {
		await $`bunx vercel link --yes`;
		console.log(c.success("Vercel project linked"));
		vercelLinked = true;
	} catch {
		console.log(
			c.warning("Could not link Vercel automatically. Run: bunx vercel link\n"),
		);
	}

	// Step 12: Add environment variables to Vercel
	if (vercelLinked) {
		console.log(c.header("Adding Environment Variables to Vercel"));
		const envTargets = ["production", "preview", "development"];

		if (convexUrl) {
			console.log(c.info("Adding VITE_CONVEX_URL..."));
			const added = await addVercelEnvVar(
				"VITE_CONVEX_URL",
				convexUrl,
				envTargets,
			);
			if (added) {
				console.log(c.success("VITE_CONVEX_URL added to Vercel"));
			} else {
				console.log(
					c.warning(
						"Could not add VITE_CONVEX_URL. Add it manually in Vercel dashboard.",
					),
				);
			}
		} else {
			console.log(
				c.warning(
					"VITE_CONVEX_URL not found. Add it manually in Vercel dashboard.",
				),
			);
		}

		if (deployKey) {
			console.log(c.info("Adding CONVEX_DEPLOY_KEY..."));
			const added = await addVercelEnvVar(
				"CONVEX_DEPLOY_KEY",
				deployKey,
				envTargets,
			);
			if (added) {
				console.log(c.success("CONVEX_DEPLOY_KEY added to Vercel"));
			} else {
				console.log(
					c.warning(
						"Could not add CONVEX_DEPLOY_KEY. Add it manually in Vercel dashboard.",
					),
				);
			}
		} else {
			console.log(
				c.warning(
					"No deploy key provided. Add CONVEX_DEPLOY_KEY manually in Vercel dashboard.",
				),
			);
			console.log("\n  1. Go to: https://vercel.com/dashboard");
			console.log(
				`  2. Select: ${projectName} → Settings → Environment Variables`,
			);
			console.log("  3. Add CONVEX_DEPLOY_KEY\n");
		}
	} else {
		console.log("");
		console.log(
			c.warning("ACTION REQUIRED: Add Environment Variables in Vercel"),
		);
		console.log("\n  1. Go to: https://vercel.com/dashboard");
		console.log(
			`  2. Select: ${projectName} → Settings → Environment Variables`,
		);
		console.log("  3. Add:");
		console.log("     - CONVEX_DEPLOY_KEY (from Convex dashboard)");
		console.log("     - VITE_CONVEX_URL (from .env.local)\n");
	}

	// Complete!
	console.log(c.header("Setup Complete!"));
	console.log(`  Project: ${projectPath}\n`);
	console.log(`  ${colors.green}Quick Start:${colors.reset}`);
	console.log(`    cd ${projectName}`);
	console.log("    bun run dev\n");
	console.log(`  ${colors.green}Deploy:${colors.reset}`);
	console.log("    bunx vercel --prod\n");
	console.log(c.success("Happy coding!"));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const skipChecks = args.includes("--skip-checks") || args.includes("-s");
	const showHelp = args.includes("--help") || args.includes("-h");
	const projectName = args.find((arg) => !arg.startsWith("-"));

	if (showHelp || !projectName) {
		console.log(`
${colors.bold}create-m10n${colors.reset}

Create a Convex + TanStack Start project for Vercel.

${colors.bold}Usage:${colors.reset}
  bunx create-m10n <project-name>

${colors.bold}Options:${colors.reset}
  -s, --skip-checks    Skip prerequisite checks
  -h, --help           Show this help message

${colors.bold}Prerequisites:${colors.reset}
  gh auth login        # GitHub CLI
  bunx convex login    # Convex CLI
  bunx vercel login    # Vercel CLI
`);
		process.exit(projectName ? 0 : 1);
	}

	if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(projectName)) {
		console.log(
			c.error(
				"Invalid project name. Use letters, numbers, hyphens, underscores. Start with a letter.",
			),
		);
		process.exit(1);
	}

	console.log(c.header("Bootstrap: Convex + TanStack Start + Vercel"));
	console.log(`  Project: ${projectName}\n`);

	if (!skipChecks) {
		const ok = await checkAllPrerequisites();
		if (!ok) process.exit(1);
	}

	await createProject(projectName);
}

main().catch((error) => {
	console.error(c.error("An error occurred:"), error);
	process.exit(1);
});
