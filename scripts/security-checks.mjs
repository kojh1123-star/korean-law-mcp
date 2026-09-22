import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
// Synthetic, locally generated values only. Never contact a credential provider.
const synthetic = createHash("sha256").update("local prevention regression fixture").digest("hex");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "Fixture Git operation failed");
  return result.stdout;
}

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "law-mcp-secret-check-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Local Security Test"]);
    git(root, ["config", "user.email", "security-test@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "core.hooksPath", join(root, "empty-hooks")]);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".tools", "gitleaks"), { recursive: true });
    for (const path of [".gitignore", ".gitleaks.toml", ".gitleaksignore", "scripts/scan-secrets.mjs"]) {
      copyFileSync(join(source, path), join(root, path));
    }
    copyFileSync(join(source, ".tools", "gitleaks", executable), join(root, ".tools", "gitleaks", executable));
    writeFileSync(join(root, "safe.txt"), "No credentials.\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Fixture baseline"]);
    run(root);
  } finally {
    // This directory is uniquely created by this test, never the source checkout.
    rmSync(root, { recursive: true, force: true });
  }
}

function scan(root, mode = "staged") {
  const result = spawnSync(process.execPath, [join(root, "scripts/scan-secrets.mjs"), mode], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(synthetic), "Scan output must redact the synthetic credential");
  return result;
}

test("benign staged content and complete history pass", () => fixture((root) => {
  writeFileSync(join(root, "safe.txt"), "Still no credentials.\n");
  git(root, ["add", "safe.txt"]);
  assert.equal(scan(root).status, 0);
  assert.equal(scan(root, "history").status, 0);
}));

for (const variable of ["KOSIS_TOKEN", "G2B_API_KEY", "serviceKey", "나라장터"]) {
  test(`${variable} literals are blocked`, () => fixture((root) => {
    writeFileSync(join(root, "credentials.txt"), `${variable}="${synthetic}"\n`);
    git(root, ["add", "credentials.txt"]);
    assert.equal(scan(root).status, 1);
  }));
}

test("default provider detection remains enabled", () => fixture((root) => {
  const fakeToken = ["ghp", synthetic.slice(0, 36)].join("_");
  writeFileSync(join(root, "provider.txt"), `Authorization: ${fakeToken}\n`);
  git(root, ["add", "provider.txt"]);
  const result = scan(root);
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fakeToken));
}));

test("partially staged secret is blocked even if worktree is clean", () => fixture((root) => {
  writeFileSync(join(root, "safe.txt"), `KOSIS_TOKEN=${synthetic}\n`);
  git(root, ["add", "safe.txt"]);
  writeFileSync(join(root, "safe.txt"), "No credentials in worktree.\n");
  assert.equal(scan(root).status, 1);
}));

test("force-added environment and private key files are blocked", () => fixture((root) => {
  for (const path of [".env.production", "private.pem"]) {
    writeFileSync(join(root, path), "benign fixture\n");
    git(root, ["add", "--force", path]);
    assert.equal(scan(root).status, 1);
    git(root, ["rm", "--cached", path]);
  }
}));

test("placeholder env examples pass but real-looking values do not", () => fixture((root) => {
  writeFileSync(join(root, ".env.example"), "KOSIS_TOKEN=your-token-here\n");
  git(root, ["add", ".env.example"]);
  assert.equal(scan(root).status, 0);
  writeFileSync(join(root, ".env.example"), `KOSIS_TOKEN=${synthetic}\n`);
  git(root, ["add", ".env.example"]);
  assert.equal(scan(root).status, 1);
}));

test("inline allow comments cannot bypass detection", () => fixture((root) => {
  writeFileSync(join(root, "safe.txt"), `KOSIS_TOKEN=${synthetic} # gitleaks:allow\n`);
  git(root, ["add", "safe.txt"]);
  assert.equal(scan(root).status, 1);
}));

test("deleted credentials remain detectable in commit history", () => fixture((root) => {
  writeFileSync(join(root, "safe.txt"), `KOSIS_TOKEN=${synthetic}\n`);
  git(root, ["add", "safe.txt"]);
  git(root, ["commit", "-m", "Synthetic secret"]);
  writeFileSync(join(root, "safe.txt"), "Removed synthetic secret.\n");
  git(root, ["add", "safe.txt"]);
  git(root, ["commit", "-m", "Remove fixture secret"]);
  assert.equal(scan(root, "history").status, 1);
}));

test("non-current branch history is scanned", () => fixture((root) => {
  git(root, ["switch", "-c", "fixture-side-branch"]);
  writeFileSync(join(root, "safe.txt"), `KOSIS_TOKEN=${synthetic}\n`);
  git(root, ["add", "safe.txt"]);
  git(root, ["commit", "-m", "Side branch fixture"]);
  git(root, ["switch", "main"]);
  assert.equal(scan(root, "history").status, 1);
}));

test("missing scanner blocks instead of silently succeeding", () => fixture((root) => {
  rmSync(join(root, ".tools", "gitleaks", executable));
  assert.equal(scan(root).status, 2);
}));

test("credentials introduced only by a merge commit are blocked", () => fixture((root) => {
  git(root, ["switch", "-c", "merge-fixture"]);
  writeFileSync(join(root, "side.txt"), "Benign branch change.\n");
  git(root, ["add", "side.txt"]);
  git(root, ["commit", "-m", "Benign side change"]);
  git(root, ["switch", "main"]);
  git(root, ["merge", "--no-ff", "--no-commit", "merge-fixture"]);
  writeFileSync(join(root, "safe.txt"), `KOSIS_TOKEN=${synthetic}\n`);
  git(root, ["add", "safe.txt"]);
  git(root, ["commit", "-m", "Synthetic merge-only credential"]);
  assert.equal(scan(root, "history").status, 1);
}));

test("incomplete shallow history fails closed", () => fixture((root) => {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(root, ".git", "shallow"), `${head}\n`);
  assert.equal(scan(root, "history").status, 2);
}));

test("invalid mode fails closed", () => fixture((root) => {
  assert.equal(scan(root, "unknown").status, 2);
}));
