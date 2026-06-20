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

# Install dependencies (clean, lockfile-faithful)
install:
    npm ci

# Everything CI runs
check: tsc test

# Bump version, tag, and push to trigger the npm publish workflow
release bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    current=$(node -e "process.stdout.write(require('./package.json').version)")
    IFS='.' read -r major minor patch <<< "$current"
    case "{{bump}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "Usage: just release [major|minor|patch]"; exit 1 ;;
    esac
    next="$major.$minor.$patch"
    echo "Bumping $current → $next"
    npm version "$next" --no-git-tag-version
    git add package.json package-lock.json
    git commit -m "v$next"
    git tag "v$next"
    git push origin main "v$next"
    echo "Released v$next — publish workflow triggered (tag pattern v*)"
