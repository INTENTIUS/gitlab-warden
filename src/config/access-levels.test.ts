import { describe, it, expect } from "vitest";
import { toAccessNumber, fromAccessNumber } from "./access-levels.js";

describe("access-level mapping", () => {
  it("maps names to GitLab numbers", () => {
    expect(toAccessNumber("developer")).toBe(30);
    expect(toAccessNumber("owner")).toBe(50);
    expect(toAccessNumber("minimal")).toBe(5);
    expect(toAccessNumber("planner")).toBe(15);
  });
  it("passes numbers through", () => {
    expect(toAccessNumber(40)).toBe(40);
  });
  it("throws on an unknown name", () => {
    expect(() => toAccessNumber("wizard" as never)).toThrow(/unknown access level/);
  });
  it("maps numbers back to names", () => {
    expect(fromAccessNumber(30)).toBe("developer");
    expect(fromAccessNumber(99)).toBe("99");
  });
});
