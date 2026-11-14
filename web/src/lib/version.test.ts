import { describe, expect, it } from "vitest";
import { V1_CONTRACT_VERSION } from "./decode";
import { checkVersion, isMethodNotFound } from "./version";

describe("the version gate", () => {
  it("turns an older contract away, takes an equal one, flags a newer one", () => {
    expect(checkVersion({ stateVersion: 1 }, 2)).toBe("old");
    expect(checkVersion(V1_CONTRACT_VERSION, 2)).toBe("old");
    expect(checkVersion({ stateVersion: 2 }, 2)).toBe("ok");
    expect(checkVersion({ stateVersion: 3 }, 2)).toBe("newer");
  });

  it("reads a missing contract_version as a v1 contract", () => {
    expect(isMethodNotFound("MethodResolveError(MethodNotFound)")).toBe(true);
    expect(isMethodNotFound("MethodNotFound: contract_version")).toBe(true);
    expect(isMethodNotFound("Account app.x.testnet does not exist")).toBe(false);
    expect(V1_CONTRACT_VERSION.stateVersion).toBe(1);
  });
});
