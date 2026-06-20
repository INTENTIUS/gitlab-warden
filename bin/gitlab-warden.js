#!/usr/bin/env node
/**
 * gitlab-warden bin launcher.
 *
 * Committed so it exists at npm pack-validation time (before `prepublishOnly`/
 * `build` runs). It loads the built dist/cli.js and calls the exported `run()`.
 */

import(new URL("../dist/cli.js", import.meta.url).href)
  .then((mod) => mod.run(process.argv.slice(2)))
  .catch((err) => {
    process.stderr.write(`gitlab-warden: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
