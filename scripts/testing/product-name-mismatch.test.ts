import { describe, expect, it } from "vitest";
import { productNameMismatch } from "./product-name-mismatch.mjs";

const error = (actual: string, expected: string, message = "expected values to equal") => ({ name: "AssertionError", actual, expected, message });

describe("product name mismatch evidence", () => {
  it("recognizes only assertions satisfied by the product name replacement", () => {
    for (const failure of [
      error("Restart to update mymausbot 0.2.0", "Restart to update MausBot 0.2.0"),
      error('<section title="mymausbot">Fully quit mymausbot</section>', "Fully quit MausBot", "expected '<section…' to contain 'Fully quit MausBot'"),
      error('{\n "name": "mymausbot",\n "version": 2\n}', '{\n "name": "MausBot",\n "version": 2\n}'),
    ]) expect(productNameMismatch([failure])).toEqual({ from: "MausBot", to: "mymausbot" });
  });

  it("does not group unrelated behavior, missing text, numbers or mixed failures", () => {
    for (const failures of [
      [],
      [error("403", "200")],
      [error("mymausbot 3", "MausBot 2")],
      [error("Not available in mymausbot", "Fully quit MausBot", "expected '…' to contain 'Fully quit MausBot'")],
      [error("mymausbot", "MausBot", "expected 'mymausbot' not to contain 'MausBot'")],
      [{ message: "MausBot crashed" }],
      [error("mymausbot", "MausBot"), error("403", "200")],
    ]) expect(productNameMismatch(failures)).toBeNull();
  });
});
