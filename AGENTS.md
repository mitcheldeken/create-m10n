# Agent Usage Guide

Use this package when the user wants a deterministic, agent-native project scaffold with Mitchel's defaults.

## Default Scaffold

Run:

```bash
bunx create-m10n <project-name>
```

This generates the default `micro-saas` recipe:

- monorepo workspace
- Vite React product app in `apps/web`
- Vite React marketing site in `apps/marketing`
- shared shadcn-style UI in `packages/ui`
- shared config in `packages/config`
- root Convex backend in `convex`
- WorkOS AuthKit through Convex
- Vercel-ready deployment files
- billing shell, not live Stripe billing

## Safe Discovery Commands

Use these before scaffolding when you need to inspect behavior:

```bash
bunx create-m10n --list
bunx create-m10n <project-name> --dry-run
bunx create-m10n <project-name> --plan-json
bunx create-m10n --update-lock micro-saas
bunx create-m10n --help
```

## Resumable Setup

Use setup mode when the user wants a connected workspace rather than files only:

```bash
bunx create-m10n <project-name> --setup
bunx create-m10n <project-name> --resume
```

The setup layer is a step DAG, not an interactive script. It writes `setup.manifest.json` into the generated project and `.m10n/setup-state.json` as gitignored resumable state. The state file must never contain secrets; it records booleans and resource IDs only. Provider gates such as Convex deploy keys are expected blockers, not failures.

## Alternative Recipe

For a compact experiment instead of a micro-SaaS monorepo:

```bash
bunx create-m10n <project-name> --recipe vite-spa-convex
```

## Generated Project Agent Rules

After generating a project:

1. Run `bun install`.
2. Run `bunx convex dev`.
3. Run `bunx convex ai-files install`.
4. Read the generated `AGENTS.md` and `convex/_generated/ai/guidelines.md`.
5. Do not write Convex backend code before reading those generated Convex guidelines.

## Guardrails

- Plain generation writes files only; `--setup` and `--resume` may create GitHub, Convex, and Vercel resources.
- Use `--plan-json` to inspect the provider DAG before mutating anything.
- Use `--no-interactive` for agent/button contexts that must never prompt.
- Use `--dry-run` before generating when the target directory or recipe choice is uncertain.
- Keep `micro-saas` as the default unless the user explicitly asks for a smaller experiment scaffold.
- Treat `recipe.lock.json` in generated projects as the source of pinned scaffold versions.

## Live Smoke Harness

Only run authenticated provider smoke tests when the user explicitly asks for a live run:

```bash
CREATE_M10N_LIVE_SMOKE=1 bun run smoke:live
```

This creates a disposable Convex resource for the `vite-spa-convex` recipe,
checks GitHub authentication/owner/scope/repository-name availability without
creating a GitHub repo, writes `/tmp/<slug>.cleanup.json`, and removes the temp
checkout. Convex cleanup is manual and recorded in the manifest. For
non-interactive deploy-key setup, use
`CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY` or
`CREATE_M10N_CONVEX_PRODUCTION_DEPLOY_KEY`; raw keys must not appear in
`.m10n/setup-state.json`.
