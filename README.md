# create-m10n

Deterministic, agent-native scaffolds and resumable setup plans for micro-SaaS projects.

> m10n = mitcheldeken (numeronym)

## Default Usage

```bash
bunx create-m10n my-saas
```

This is equivalent to:

```bash
bunx create-m10n my-saas \
  --recipe micro-saas \
  --shape monorepo \
  --auth workos \
  --deploy vercel \
  --billing shell \
  --pm bun
```

## What This Creates

```text
apps/web          # Vite React product app with WorkOS + Convex
apps/marketing    # Vite React static marketing/pricing site
convex/           # Shared Convex backend and AuthKit config
packages/ui       # Shared shadcn-style UI primitives and tokens
packages/config   # Shared TypeScript/tooling config
docs/             # Architecture, deployment, env, and feature workflow docs
```

By default the generator writes files deterministically and prints the next commands. Cloud resources are only touched when you opt into resumable setup with `--setup` or `--resume`.

## Setup Vision

`create-m10n` is designed around "one command, minimal stops": generate a working codebase, compute the provider setup graph, execute safe provider steps, and pause explicitly when a provider requires human consent or a dashboard-minted secret. The pause is not an error path; it writes redacted resumable state so an agent can continue without rediscovering the project.

```bash
bunx create-m10n my-saas --setup
bunx create-m10n my-saas --resume
```

The current setup foundation writes:

- `setup.manifest.json` - tracked desired setup graph.
- `.m10n/setup-state.json` - gitignored resumable execution state with no secrets.

Preview the setup graph without writing files:

```bash
bunx create-m10n my-saas --plan-json
```

## Agent Usage

Agents should inspect before generating:

```bash
bunx create-m10n --list
bunx create-m10n my-saas --dry-run
bunx create-m10n my-saas --plan-json
bunx create-m10n --update-lock micro-saas
```

After generating a project, agents should run `bunx convex ai-files install` and read the generated `AGENTS.md` plus `convex/_generated/ai/guidelines.md` before writing Convex backend code. This package also ships a package-level `AGENTS.md` with the same guardrails.

## Recipes

```bash
bunx create-m10n --list
```

- `micro-saas` - default monorepo for product app, marketing site, shared UI, Convex, WorkOS AuthKit, and Vercel-ready deployment.
- `vite-spa-convex` - small standalone Vite React + Convex app for experiments.

## Useful Commands

```bash
# Preview generated files without writing
bunx create-m10n my-saas --dry-run

# Generate the compact experiment scaffold
bunx create-m10n scratch-app --recipe vite-spa-convex

# Print pinned recipe metadata
bunx create-m10n --update-lock micro-saas

# Install dependencies after writing files
bunx create-m10n my-saas --install

# Initialize git after writing files
bunx create-m10n my-saas --git
```

## Live Smoke Harness

The live smoke harness is for maintainers who want to verify authenticated
provider setup against disposable resources. It is intentionally gated and uses
the compact `vite-spa-convex` recipe to avoid WorkOS, Vercel, and production
deployments in the first smoke path.

```bash
CREATE_M10N_LIVE_SMOKE=1 bun run smoke:live
```

Optional scoping variables:

```bash
CREATE_M10N_GITHUB_OWNER=<user-or-org>
CREATE_M10N_CONVEX_TEAM=<team-slug>
CREATE_M10N_CONVEX_PREVIEW_DEPLOY_KEY=<preview-key>
CREATE_M10N_CONVEX_PRODUCTION_DEPLOY_KEY=<production-key>
```

The script generates a project named like `m10n-smoke-YYYYMMDD-random` under
`/tmp`, runs the same setup DAG as the CLI, and writes
`/tmp/<slug>.cleanup.json`. GitHub is checked without mutation: the smoke
verifies `gh` authentication, owner visibility, `repo` token scope, and that the
disposable repository name is available, but it does not create or delete a
repository. Convex is still initialized against the live service, so Convex
cleanup is recorded as a manual dashboard action until there is a verified safe
non-interactive deletion path.

## Generated Project Quick Start

```bash
cd my-saas
bun install
bunx convex dev
bunx convex ai-files install
bun run dev
```

Before writing Convex backend code, read the generated Convex AI guidelines and `AGENTS.md`.

## Options

```text
--recipe <id>          micro-saas | vite-spa-convex
--auth <id>            workos | none
--deploy <id>          vercel | none
--billing <id>         shell | none
--shape <id>           monorepo | standalone
--pm <id>              bun
--dry-run              Print generated files without writing
--setup                Generate files and run the resumable setup DAG
--resume               Resume setup from .m10n/setup-state.json
--plan-json            Print the redacted setup DAG without writing files
--profile <file>       Load setup defaults from a JSON profile
--github-owner <owner> GitHub owner or organization for setup
--vercel-scope <team>  Vercel team or user scope for setup
--convex-team <team>   Convex team for setup
--visibility <value>   private | public (default private)
--no-interactive       Never prompt; write blocker state and exit non-zero
--no-preview           Skip preview deployment steps
--production           Allow production deployment steps when supported
--install              Run package installation after writing files
--git                  Initialize git and create the first commit
--list                 List available recipes
--update-lock <id>     Print current lock metadata for a recipe
-s, --skip-checks      Skip local prerequisite checks
-h, --help             Show help
```

## Development

```bash
bun test
bun index.ts example-saas --dry-run
```

## License

MIT
