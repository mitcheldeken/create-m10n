import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { createContext, parseArgs, toProjectSlug } from "../src/cli";
import { listGeneratedFiles, writeGeneratedFiles } from "../src/files";
import { getRecipe } from "../src/recipes";
import { redact } from "../src/setup";

describe("cli options", () => {
	test("defaults to the micro-saas monorepo recipe", () => {
		const options = parseArgs(["Acme_SaaS"]);

		expect(options.recipe).toBe("micro-saas");
		expect(options.shape).toBe("monorepo");
		expect(options.auth).toBe("workos");
		expect(options.deploy).toBe("vercel");
		expect(options.billing).toBe("shell");
		expect(options.packageManager).toBe("bun");
		expect(toProjectSlug("Acme_SaaS")).toBe("acme-saas");
	});

	test("supports the compact vite-spa-convex recipe", () => {
		const options = parseArgs(["notes", "--recipe", "vite-spa-convex"]);

		expect(options.recipe).toBe("vite-spa-convex");
		expect(options.shape).toBe("standalone");
		expect(options.auth).toBe("none");
		expect(options.billing).toBe("none");
	});

	test("rejects unsupported recipe combinations", () => {
		expect(() =>
			parseArgs(["app", "--recipe", "micro-saas", "--shape", "standalone"]),
		).toThrow(/Unsupported shape/);
	});

	test("honors cli over profile defaults", () => {
		const options = parseArgs(
			["app", "--visibility", "public", "--github-owner", "cli-owner"],
			{
				githubOwner: "profile-owner",
				visibility: "private",
				noPreview: true,
			},
		);

		expect(options.githubOwner).toBe("cli-owner");
		expect(options.visibility).toBe("public");
		expect(options.noPreview).toBe(true);
	});
});

describe("recipe output", () => {
	test("micro-saas generates the expected workspace shape", () => {
		const options = parseArgs(["my-saas"]);
		const context = createContext(options);
		const project = getRecipe(options.recipe).create(context);
		const files = listGeneratedFiles(project.files);

		expect(files).toContain("apps/web/src/App.tsx");
		expect(files).toContain("apps/marketing/src/App.tsx");
		expect(files).toContain("convex/auth.config.ts");
		expect(files).toContain("packages/ui/src/components/ui/button.tsx");
		expect(files).toContain("docs/architecture.md");
		expect(files).toContain("recipe.lock.json");
	});

	test("micro-saas setup plan includes preview provider gates and two Vercel projects", () => {
		const options = parseArgs([
			"my-saas",
			"--setup",
			"--github-owner",
			"acme",
			"--vercel-scope",
			"acme-team",
			"--convex-team",
			"acme-convex",
		]);
		const context = createContext(options);
		const plan = getRecipe(options.recipe).planSetup(context);
		const ids = plan.steps.map((step) => step.id);

		expect(ids).toContain("github.repo");
		expect(ids).toContain("convex.deployKey.preview");
		expect(ids).not.toContain("convex.deployKey.production");
		expect(ids).toContain("vercel.product.create");
		expect(ids).toContain("vercel.marketing.create");
		expect(ids).toContain("deploy.product.preview");
		expect(
			plan.steps.find((step) => step.id === "vercel.marketing.env")?.metadata,
		).toEqual({ VITE_APP_URL: "product-production-domain" });
	});

	test("production setup steps are explicit opt-in", () => {
		const options = parseArgs(["my-saas", "--setup", "--production"]);
		const context = createContext(options);
		const plan = getRecipe(options.recipe).planSetup(context);
		const ids = plan.steps.map((step) => step.id);

		expect(ids).toContain("convex.deployKey.production");
		expect(ids).toContain("deploy.product.production");
		expect(ids).toContain("deploy.marketing.production");
	});

	test("vite-spa-convex default setup plan omits auth and Vercel steps", () => {
		const options = parseArgs(["notes", "--recipe", "vite-spa-convex"]);
		const context = createContext(options);
		const plan = getRecipe(options.recipe).planSetup(context);
		const ids = plan.steps.map((step) => step.id);

		expect(ids).toContain("convex.init");
		expect(ids).not.toContain("convex.authkit");
		expect(ids).not.toContain("vercel.product.create");
		expect(ids).not.toContain("convex.deployKey.preview");
	});

	test("redacts secret-shaped values recursively", () => {
		expect(
			redact({
				token: "abc",
				nested: {
					deployKeyPreview: "preview:super-secret",
					publicName: "visible",
				},
			}),
		).toEqual({
			token: "[REDACTED]",
			nested: {
				deployKeyPreview: "[REDACTED]",
				publicName: "visible",
			},
		});
	});

	test("generated paths cannot escape the project root", async () => {
		const root = await mkdtemp(join("/tmp", "create-m10n-"));

		try {
			await expect(
				writeGeneratedFiles(join(root, "project"), [
					{ path: "../escape.txt", contents: "nope" },
				]),
			).rejects.toThrow(/Unsafe generated path/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
