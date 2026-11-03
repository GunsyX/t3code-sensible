import { describe, expect, it } from "vite-plus/test";

import { isPatchedBuildOverdue, parseFeedRepository } from "./PatchedBuildAlert.ts";

const HOUR = 60 * 60 * 1000;

describe("isPatchedBuildOverdue", () => {
  it.each([
    {
      name: "no build after the grace period",
      app: "0.1.6",
      offered: null,
      age: 9,
      expected: true,
    },
    { name: "still inside the grace period", app: "0.1.6", offered: null, age: 7, expected: false },
    { name: "already running that version", app: "0.1.7", offered: null, age: 99, expected: false },
    {
      name: "patched build already offered",
      app: "0.1.6",
      offered: "0.1.7",
      age: 99,
      expected: false,
    },
    {
      name: "only an older build offered",
      app: "0.1.5",
      offered: "0.1.6",
      age: 99,
      expected: true,
    },
  ])("$name", ({ app, offered, age, expected }) => {
    expect(
      isPatchedBuildOverdue({
        appVersion: app,
        offeredVersion: offered,
        upstreamVersion: "0.1.7",
        upstreamAgeMillis: age * HOUR,
      }),
    ).toBe(expected);
  });
});

describe("parseFeedRepository", () => {
  it("reads the update feed from app-update.yml", () => {
    expect(parseFeedRepository("owner: GunsyX\r\nrepo: t3code\r\nprovider: github\r\n")).toBe(
      "GunsyX/t3code",
    );
  });

  it("has no repository for a generic feed", () => {
    expect(parseFeedRepository("provider: generic\nurl: http://localhost\n")).toBeNull();
  });
});
