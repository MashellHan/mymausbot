import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", { spy: true });
vi.resetModules();
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const spied = await import("node:fs");
const { createTeamPeople } = await import("./team-people.ts");

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(spied.fsyncSync).mockImplementation(actual.fsyncSync);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("keeps a second team member across restart after one fsync EIO", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-people-fsync-"));
  dirs.push(dir);
  let calls = 0;
  vi.mocked(spied.fsyncSync).mockImplementation((fd) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    return actual.fsyncSync(fd);
  });

  const people = createTeamPeople(dir);
  people.seen("Ada@acme.test", "admin");
  people.seen("bob@acme.test", "member");

  expect(calls).toBe(3);
  expect(createTeamPeople(dir).list().map(({ email, role }) => [email, role])).toEqual([
    ["ada@acme.test", "admin"], ["bob@acme.test", "member"],
  ]);
  expect(readdirSync(dir)).toEqual(["team-people.json"]);
});
