# create-convex-vercel

Create a [Convex](https://convex.dev) + [TanStack Start](https://tanstack.com/start) project configured for [Vercel](https://vercel.com) deployment.

## Usage

```bash
bunx create-convex-vercel my-project
```

Or with npm:

```bash
npx create-convex-vercel my-project
```

## Prerequisites

Before running, authenticate with all required services:

```bash
# GitHub CLI
gh auth login

# Convex CLI
bunx convex login

# Vercel CLI
bunx vercel login
```

## What This Creates

- **TanStack Start** - Full-stack React framework
- **Convex** - Real-time database and backend
- **Tailwind CSS v4** - Utility-first CSS
- **Nitro** - Universal server runtime for Vercel deployment
- **TypeScript** - Type-safe development

## What It Does

1. Creates project from the official Convex tanstack-start template
2. Adds Nitro for Vercel serverless deployment
3. Configures `vite.config.ts` with Nitro plugin
4. Creates `vercel.json` with bun build commands
5. Updates scripts to use bun
6. Initializes Git and creates GitHub repository
7. Sets up Convex project
8. Links project to Vercel
9. **Automatically adds environment variables to Vercel**

## Development

```bash
cd my-project
bun run dev
```

## Deploy

```bash
bunx vercel --prod
```

Or push to GitHub main branch for automatic deployment.

## Options

```
-s, --skip-checks    Skip prerequisite checks
-h, --help           Show help message
```

## License

MIT
