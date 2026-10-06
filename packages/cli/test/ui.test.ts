import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { field, shortId, spinnerOptions } from "../src/ui.js";

describe("spinnerOptions", () => {
  const original = { isTTY: process.stderr.isTTY, columns: process.stderr.columns };
  const setTerminal = (isTTY: boolean | undefined, columns: number | undefined) => {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    Object.defineProperty(process.stderr, "columns", { value: columns, configurable: true });
  };
  afterEach(() => setTerminal(original.isTTY, original.columns));

  it("uses ora's defaults on a terminal with a width", () => {
    setTerminal(true, 100);
    assert.deepEqual(spinnerOptions("working"), { text: "working" });
  });

  it("uses ora's defaults when stderr is not a terminal (ora prints plain lines itself)", () => {
    setTerminal(false, undefined);
    assert.deepEqual(spinnerOptions("working"), { text: "working" });
  });

  it("turns the animation off on a terminal that reports zero columns, where ora would loop forever", () => {
    setTerminal(true, 0);
    assert.deepEqual(spinnerOptions("working"), { text: "working", isEnabled: false });
    setTerminal(true, undefined);
    assert.deepEqual(spinnerOptions("working"), { text: "working", isEnabled: false });
  });
});

describe("formatting helpers", () => {
  it("shortens ids to eight characters", () => {
    assert.equal(shortId("2e90322c-a1c2-4b56-8338-8037da649bb3"), "2e90322c");
  });

  it("aligns detail lines and marks empty values as none", () => {
    // eslint-disable-next-line no-control-regex
    const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(plain(field("Status", "running")), "  Status        running");
    assert.equal(plain(field("Endpoint", null)), "  Endpoint      none");
    assert.equal(plain(field("Reason", "")), "  Reason        none");
  });
});
