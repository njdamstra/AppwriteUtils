# @njdamstra/appwrite-utils

Fork of [ZachHandley/AppwriteUtils](https://github.com/ZachHandley/AppwriteUtils) published under the `@njdamstra` npm scope.

## Fork Relationship

- **origin**: `git@github.com:njdamstra/AppwriteUtils.git` (our fork)
- **upstream**: `https://github.com/ZachHandley/AppwriteUtils.git` (Zach's original)
- **Main branch**: `dev`
- All packages are renamed from `appwrite-utils*` to `@njdamstra/appwrite-utils*`

### Syncing & Publishing

Use `./scripts/publish-sync.sh` (flags required):

```bash
./scripts/publish-sync.sh --sync           # Pull Zach's latest, re-apply renames, build
./scripts/publish-sync.sh --publish        # Build and publish our packages to npm
./scripts/publish-sync.sh --sync-publish   # Both
```

Bump version in the relevant `package.json` before `--publish`. The script handles swapping `workspace:*` to real versions for npm and restoring after.

## Monorepo Structure

4 packages, managed with **pnpm workspaces**, built with **bun**:

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/appwrite-utils` | `@njdamstra/appwrite-utils` | Core library: types, schemas, validators, converters |
| `packages/appwrite-utils-helpers` | `@njdamstra/appwrite-utils-helpers` | Shared helpers: adapters, config loading, schema generation, logging |
| `packages/appwrite-utils-cli` | `@njdamstra/appwrite-utils-cli` | CLI tool (`appwrite-migrate` bin): migrations, sync, import, backup |
| `packages/appwrite-utils-mcp` | `@njdamstra/appwrite-utils-mcp` | MCP server (`appwrite-mcp` bin): Model Context Protocol integration |

### Dependency Order

```
appwrite-utils → appwrite-utils-helpers → appwrite-utils-cli
                                        → appwrite-utils-mcp
```

Build and publish must follow this order. The `pnpm build` script already does this.

## Tech Stack

- **Language**: TypeScript (ESNext target, NodeNext modules, strict mode)
- **Package Manager**: pnpm 10.11+ with workspaces
- **Build Runtime**: Bun
- **Validation**: Zod v4
- **Appwrite SDKs**: `appwrite` (browser), `node-appwrite` (server)
- **CLI Framework**: Commander.js + Inquirer
- **Logging**: Winston
- **Testing**: Jest (CLI package only): `cd packages/appwrite-utils-cli && pnpm test`

## Commands

```bash
pnpm install          # Install all workspace deps
pnpm build            # Build all packages in order
pnpm test             # (from CLI package dir) Run jest tests

# Individual package build
bun --cwd packages/appwrite-utils run build
bun --cwd packages/appwrite-utils-helpers run build
bun --cwd packages/appwrite-utils-cli run build
bun --cwd packages/appwrite-utils-mcp run build

# Run CLI locally
cd packages/appwrite-utils-cli && tsx --no-cache src/main.ts --it
```

## Scope Renaming Rules

When syncing upstream, the `publish-sync.sh` script applies these renames (idempotent):

- Package names in `package.json`: `appwrite-utils*` → `@njdamstra/appwrite-utils*`
- All `from "appwrite-utils"` / `from "appwrite-utils-helpers"` imports → `@njdamstra/` prefixed
- Dynamic `import("appwrite-utils*")` calls (including multi-line)
- Workspace deps: `"appwrite-utils": "workspace:*"` → `"@njdamstra/appwrite-utils": "workspace:*"`
- Repo URLs: `zachhandley/AppwriteUtils` → `njdamstra/AppwriteUtils`
- Embedded strings: service name, generator name, banner text
- README install/import examples

**Left unchanged** (intentionally):
- JSON Schema `$id` URLs (`appwrite-utils.dev`) — breaking these would break user configs
- Filesystem/directory paths (`packages/appwrite-utils/`)
- CLI bin name: `appwrite-migrate`
- Changelog entries (historical)

## CI/CD

GitHub Actions workflow at `.github/workflows/release.yml`:
- Triggers on push to default branch, tags (`cli-v*`, `v-*`), or manual dispatch
- Checks each package for version changes vs npm registry
- Builds and publishes changed packages
- Requires `NPM_ACCESS_TOKEN` secret

## Key Files

- `scripts/publish-sync.sh` — Main publish/sync script
- `scripts/ci/prepare-publish.js` — Swaps workspace refs to real versions before CI publish
- `scripts/ci/check-publish.sh` — Determines if a package needs publishing (semver comparison)
- `packages/appwrite-utils-cli/src/main.ts` — CLI entry point with all command definitions
- `packages/appwrite-utils-cli/src/interactiveCLI.ts` — Interactive mode UI
- `packages/appwrite-utils/src/schemas/` — All Zod schemas (shared types)
- `packages/appwrite-utils-helpers/src/config/` — Config loading, validation, migration
