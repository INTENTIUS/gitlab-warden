/**
 * gitlab-warden CLI — early preview.
 *
 * This is a placeholder entry point, published to establish the
 * `@intentius/gitlab-warden` package and its OIDC release pipeline. The
 * reconcile engine (REST/GraphQL client, cycles, runner) is under active
 * development — see the roadmap:
 *   https://github.com/INTENTIUS/gitlab-warden/issues/21
 *
 * The functional `reconcile` command lands with the foundation + cycle issues.
 */

// Keep in sync with package.json until the CLI is wired to it (issue #6).
const VERSION = "0.1.0";

const USAGE = `gitlab-warden ${VERSION} — declarative governance for GitLab groups & projects

  ⚠️  Early preview. The reconcile engine is under active development.
      Roadmap: https://github.com/INTENTIUS/gitlab-warden/issues/21

Planned usage:
  gitlab-warden reconcile --config <path> [--mode dry-run|apply] [--cycles ...]

Flags:
  -h, --help       Show this help
  -v, --version    Print the version

Today this command prints help only; functional reconcile arrives with the
cycles on the roadmap.
`;

export async function run(argv: string[] = []): Promise<void> {
  const arg = argv[0];
  if (arg === "-v" || arg === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  process.stdout.write(USAGE);
}
