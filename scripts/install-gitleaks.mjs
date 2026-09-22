import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "8.30.1";
// Release checksums from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1
// Pin the expected archive hash in source, not a second mutable download.
const releases = {
  "linux-x64": ["linux_x64.tar.gz", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"],
  "linux-arm64": ["linux_arm64.tar.gz", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"],
  "darwin-x64": ["darwin_x64.tar.gz", "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"],
  "darwin-arm64": ["darwin_arm64.tar.gz", "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"],
  "win32-x64": ["windows_x64.zip", "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"],
  "win32-arm64": ["windows_arm64.zip", "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f"],
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error("Unsupported Gitleaks platform; do not bypass secret checks.");
const [suffix, expectedHash] = release;
const archiveName = `gitleaks_${version}_${suffix}`;
const executable = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
const target = join(root, ".tools", "gitleaks");
const temporary = mkdtempSync(join(tmpdir(), "law-mcp-gitleaks-"));

try {
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archiveName}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== expectedHash) {
    throw new Error("Gitleaks checksum mismatch; nothing was installed.");
  }
  const archivePath = join(temporary, archiveName);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  // macOS/Linux tar and the built-in Windows 10/11 tar support these archives.
  const extraction = spawnSync("tar", ["--no-same-owner", "-xf", archivePath, "-C", temporary, executable], {
    stdio: "inherit", windowsHide: true,
  });
  if (extraction.error || extraction.status !== 0) throw new Error("Could not extract Gitleaks; tar is required.");
  const source = join(temporary, executable);
  chmodSync(source, 0o755);
  const check = spawnSync(source, ["version"], { encoding: "utf8", windowsHide: true });
  if (check.status !== 0 || check.stdout.trim() !== version) throw new Error("Unexpected Gitleaks version.");
  mkdirSync(target, { recursive: true });
  copyFileSync(source, join(target, executable));
  chmodSync(join(target, executable), 0o755);
  console.log(`Installed checksum-verified Gitleaks ${version} in .tools/gitleaks.`);
} finally {
  // Only remove the unique installer-owned temporary directory.
  rmSync(temporary, { recursive: true, force: true });
}
