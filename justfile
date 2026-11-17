# gitlab-warden task runner. Run `just` to list recipes.

set quiet

default:
    @just --list

# Type-check (no emit)
tsc:
    npx tsc --noEmit

# Run the test suite (optionally: just test <pattern>)
test *args:
    npx vitest run {{args}}

# Build the CLI bundle (dist/cli.js)
build:
    npm run build

# Dogfood: audit our own config with chant (CI's `dogfood-audit` job)
audit:
    npx chant audit . --fail-on merge-worthy

# Install dependencies (clean, lockfile-faithful)
install:
    npm ci

# Everything CI runs
check: tsc test

# Start the hermetic e2e stack (compose up + mint token); GitLab CE is slow.
# The exports land on stdout, so: eval "$(just e2e-up)"
e2e-up:
    bash e2e/bootstrap.sh

# Stop the e2e stack and discard its state (compose down -v)
e2e-down:
    docker compose -f e2e/docker-compose.yml down -v

# Build the docs site locally (requires `pip install mkdocs-material`)
docs:
    npm run lint:prose
    ./mkdocs-stage.sh && mkdocs build --strict

# Preview the docs site locally
docs-serve:
    ./mkdocs-stage.sh && mkdocs serve

# Print the next release's label, from the conventional commits since the last release
release-next:
    npx chant release next

# Print what a release of HEAD would record, tag and publish (a dry run; nothing is written)
release-plan label="auto":
    npx chant release cut {{label}} --dry-run --build 'npm run build'

# Start a release: the publish workflow cuts the newest green commit and publishes it to npm
release label="auto":
    gh workflow run publish.yml --repo INTENTIUS/gitlab-warden -f label={{label}}
