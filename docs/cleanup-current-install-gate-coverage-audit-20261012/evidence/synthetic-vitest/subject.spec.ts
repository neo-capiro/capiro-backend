import { describe, expect, it } from "vitest";
import { classify } from "./subject";
describe("synthetic V8 provider toolchain", () => {
  it("covers positive branch", () => expect(classify(1)).toBe("positive"));
  it("covers negative branch", () => expect(classify(-1)).toBe("negative"));
  it("covers zero branch", () => expect(classify(0)).toBe("zero"));
});
