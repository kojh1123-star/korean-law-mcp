import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (!["staged", "history"].includes(mode)) {
  console.error("Usage: node scripts/scan-secrets.mjs staged|history");
  process.exit(2);
}
const executable = join(root, ".tools", "gitleaks", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
if (!existsSync(executable)) {
  console.error("Secret checks cannot run. Run npm run security:setup first; commit/push is blocked.");
  process.exit(2);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error("Could not inspect Git state; secret checks failed closed.");
    process.exit(2);
  }
  return result.stdout;
}

const paths = (mode === "staged"
  ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  : git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean);
const forbidden = paths.filter((path) => {
  const name = basename(path).toLowerCase();
  const envFile = (name === ".env" || name.startsWith(".env.")) && !name.endsWith(".example");
  return envFile || /\.(?:pem|key|p12|pfx)$/.test(name) || /^(?:id_rsa|id_ed25519)$/.test(name);
});
if (forbidden.length) {
  // Filenames only: never echo sensitive file contents.
  console.error(`Credential files must not be committed:\n${forbidden.map((path) => JSON.stringify(path)).join("\n")}`);
  process.exit(1);
}

const args = ["git", "--redact=100", "--no-banner", "--no-color", "--ignore-gitleaks-allow",
  "--config", join(root, ".gitleaks.toml"), "--gitleaks-ignore-path", join(root, ".gitleaksignore")];
if (mode === "staged") args.push("--staged");
else {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error("Full history is required. Fetch the full repository before pushing.");
    process.exit(2);
  }
  // Include merge diffs and every locally available ref; no network/auth calls.
  args.push("--log-opts=--all --full-history -m");
}
args.push(root);
const scan = spawnSync(executable, args, { cwd: root, stdio: "inherit", windowsHide: true });
if (scan.error) console.error("Secret scanner failed to start; commit/push is blocked.");
if (scan.status !== 0) console.error("Secret scan failed. Fix findings before committing or pushing; never paste credentials in an issue.");
process.exit(scan.status ?? 2);
