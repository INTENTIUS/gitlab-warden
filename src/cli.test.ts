import { describe, it, expect, vi } from "vitest";
import { run } from "./cli.js";

async function capture(argv: string[]): Promise<string> {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((s: string | Uint8Array) => {
      out += typeof s === "string" ? s : s.toString();
      return true;
    }) as typeof process.stdout.write);
  await run(argv);
  spy.mockRestore();
  return out;
}

describe("gitlab-warden cli (preview)", () => {
  it("prints usage by default", async () => {
    const out = await capture([]);
    expect(out).toContain("gitlab-warden");
    expect(out).toContain("Early preview");
  });

  it("--version prints a semver", async () => {
    const out = await capture(["--version"]);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
