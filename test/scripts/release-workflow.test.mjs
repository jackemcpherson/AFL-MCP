import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = resolve("scripts/resolve-release.sh");
let directory;
let checkout;
let tagSha;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Release test",
      GIT_AUTHOR_EMAIL: "release-test@example.com",
      GIT_COMMITTER_NAME: "Release test",
      GIT_COMMITTER_EMAIL: "release-test@example.com",
    },
  }).trim();
}

function run(tag, ref = "refs/heads/main") {
  const output = join(directory, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [script], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: tag,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: ref,
      GITHUB_OUTPUT: output,
    },
  });
  return { status: result.status, output: readFileSync(output, "utf8") };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "release-workflow-test-"));
  const remote = join(directory, "remote");
  git(directory, "init", "--initial-branch=main", remote);
  writeFileSync(join(remote, "package.json"), '{"version":"5.0.0"}\n');
  git(remote, "add", "package.json");
  git(remote, "commit", "-m", "Prepare release");
  tagSha = git(remote, "rev-parse", "HEAD");
  git(remote, "tag", "v5.0.0");
  git(remote, "tag", "v6.0.0");
  writeFileSync(join(remote, "README.md"), "Later main change\n");
  git(remote, "add", "README.md");
  git(remote, "commit", "-m", "Advance main");
  git(remote, "switch", "-c", "feature");
  writeFileSync(join(remote, "package.json"), '{"version":"7.0.0"}\n');
  git(remote, "add", "package.json");
  git(remote, "commit", "-m", "Unmerged change");
  git(remote, "tag", "v7.0.0");
  git(remote, "switch", "main");
  checkout = join(directory, "checkout");
  git(directory, "clone", remote, checkout);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("release revision resolution", () => {
  it("checks the tagged commit even when main has advanced", () => {
    expect(run("v5.0.0")).toEqual({ status: 0, output: `sha=${tagSha}\ntag=v5.0.0\n` });
  });
  it("rejects a tag whose package version differs", () => {
    expect(run("v6.0.0").status).not.toBe(0);
  });
  it("rejects an unmerged release commit", () => {
    expect(run("v7.0.0").status).not.toBe(0);
  });
  it("rejects dispatch from an unreviewed branch", () => {
    expect(run("v5.0.0", "refs/heads/feature").status).not.toBe(0);
  });
});
