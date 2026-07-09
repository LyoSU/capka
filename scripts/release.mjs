#!/usr/bin/env node
// Cut a release in one step: bump package.json, move CHANGELOG's [Unreleased]
// into a dated section, commit `chore(release): cut vX.Y.Z`, and tag it.
//
// The git tag stays the single source of truth for the running version (CI
// stamps it into the image as CAPKA_VERSION — package.json is not read at
// runtime); this script just keeps package.json honest so the repo and the
// last tag never drift. Pushing is left to you, on purpose.
//
//   npm run release 0.6.5      # explicit version
//   npm run release patch      # bump last tag's patch/minor/major
//
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) die("usage: npm run release <x.y.z | patch | minor | major>");

// Refuse to run on a dirty tree — a release commit must contain only the bump.
if (git("status", "--porcelain")) die("working tree is dirty; commit or stash first");

// Resolve the target version.
const lastTag = (() => {
  try {
    return git("describe", "--tags", "--abbrev=0").replace(/^v/, "");
  } catch {
    return "0.0.0";
  }
})();

let version;
if (["patch", "minor", "major"].includes(arg)) {
  const [maj, min, pat] = lastTag.split(".").map(Number);
  version =
    arg === "major" ? `${maj + 1}.0.0` : arg === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
} else if (/^\d+\.\d+\.\d+$/.test(arg)) {
  version = arg;
} else {
  die(`"${arg}" is not a semver x.y.z or a bump keyword`);
}

const tag = `v${version}`;
try {
  if (git("tag", "--list", tag)) die(`tag ${tag} already exists`);
} catch {
  /* no tags yet */
}

// 1. package.json version.
const pkgPath = new URL("../package.json", import.meta.url);
const pkgRaw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw);
// Preserve formatting/trailing newline by editing the one field textually.
const nextPkg = pkgRaw.replace(
  /("version":\s*)"[^"]*"/,
  `$1"${version}"`,
);
if (nextPkg === pkgRaw && pkg.version !== version) die("could not rewrite package.json version");
writeFileSync(pkgPath, nextPkg);

// 2. CHANGELOG: insert a dated heading right under [Unreleased], leaving it
//    empty for the next cycle. Mirrors the Keep a Changelog convention.
const clPath = new URL("../CHANGELOG.md", import.meta.url);
const cl = readFileSync(clPath, "utf8");
const marker = "## [Unreleased]";
if (!cl.includes(marker)) die("CHANGELOG.md has no ## [Unreleased] section");
const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
const nextCl = cl.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
writeFileSync(clPath, nextCl);

// 3. Commit + tag. No push — that stays a deliberate, separate step.
git("add", "package.json", "CHANGELOG.md");
git("commit", "-m", `chore(release): cut ${tag}`);
git("tag", tag);

console.log(`Cut ${tag}. Review, then:\n  git push origin master && git push origin ${tag}`);
