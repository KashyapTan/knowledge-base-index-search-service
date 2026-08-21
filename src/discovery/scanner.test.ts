import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupStateStore } from "../config/index.ts";
import { JsonFileManifest } from "./manifest.ts";
import { RepositoryScanner } from "./scanner.ts";

let fixture = "";
let root = "";
let state = "";
const rootIdentity = "fixture-root-identity";

async function openManifest(name = "manifest.json"): Promise<JsonFileManifest> {
  const result = await JsonFileManifest.open(join(state, name), rootIdentity);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function scanOrThrow(
  scanner: RepositoryScanner,
  source: "scan" | "watch" | "reconcile" = "scan",
) {
  const result = await scanner.scan(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-scanner-")));
  root = join(fixture, "source");
  state = join(fixture, "state");
  await Promise.all([mkdir(root), mkdir(state)]);
});

afterEach(async () => {
  await chmod(join(root, "locked.txt"), 0o600).catch(() => undefined);
  await rm(fixture, { recursive: true, force: true });
});

describe("repository scanning", () => {
  test("discovers deterministically, detects text, isolates failures, and stays inside root", async () => {
    const docs = join(root, "docs");
    const git = join(root, ".git");
    const ignored = join(root, "scratch");
    await Promise.all([mkdir(docs), mkdir(git), mkdir(ignored)]);
    await Promise.all([
      writeFile(join(docs, "readme.md"), "# Read me\n"),
      writeFile(join(root, "NOTICE"), "ordinary extensionless text\n"),
      writeFile(join(root, ".hidden.txt"), "visible hidden file\n"),
      writeFile(join(root, "empty"), ""),
      writeFile(join(root, "binary.asset"), new Uint8Array([65, 0, 66])),
      writeFile(join(root, "invalid.py"), new Uint8Array([0xc3, 0x28])),
      writeFile(join(git, "config"), "must not be indexed"),
      writeFile(join(ignored, "skip.md"), "explicitly ignored"),
      writeFile(join(root, "large.log"), "line\n".repeat(40_000)),
    ]);
    const external = join(fixture, "outside.txt");
    await writeFile(external, "outside");
    await symlink(join(docs, "readme.md"), join(root, "readme-link.md"));
    await symlink(external, join(root, "outside-link.txt"));
    await symlink(root, join(docs, "cycle"));

    const beforeNames = await readdir(root);
    const manifest = await openManifest();
    const scanner = new RepositoryScanner({ identity: rootIdentity, path: root }, manifest, {
      concurrency: 3,
      ignorePatterns: ["scratch/"],
    });
    const progressEvents: unknown[] = [];
    scanner.subscribeProgress((progress) => progressEvents.push(progress));
    const first = await scanOrThrow(scanner);
    const paths = first.files.map((file) => file.relativePath);

    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("docs/readme.md");
    expect(paths).toContain("readme-link.md");
    expect(paths).not.toContain("docs/cycle/docs/readme.md");
    expect(paths).not.toContain(".git/config");
    expect(paths).not.toContain("scratch/skip.md");
    expect(first.files.find((file) => file.relativePath === "NOTICE")).toMatchObject({
      format: "text",
      readStatus: "ready",
    });
    expect(first.files.find((file) => file.relativePath === "empty")?.readStatus).toBe("ready");
    expect(first.files.find((file) => file.relativePath === ".hidden.txt")?.readStatus).toBe(
      "ready",
    );
    expect(first.files.find((file) => file.relativePath === "binary.asset")?.readStatus).toBe(
      "unsupported",
    );
    expect(first.files.find((file) => file.relativePath === "invalid.py")?.readStatus).toBe(
      "malformed",
    );
    expect(first.files.find((file) => file.relativePath === "outside-link.txt")?.readStatus).toBe(
      "unsafe",
    );
    expect(
      first.files.every(
        (file) =>
          file.readStatus === "unsafe" ||
          file.canonicalPath === root ||
          file.canonicalPath.startsWith(`${root}/`),
      ),
    ).toBe(true);
    expect(new Set(first.files.map((file) => file.fileId)).size).toBe(first.files.length);
    expect(progressEvents.at(-1)).toEqual(first.progress);
    expect(first.progress).toMatchObject({ phase: "complete", pending: 0, removed: 0 });
    expect(await readdir(root)).toEqual(beforeNames);
    expect(await Bun.file(join(root, "manifest.json")).exists()).toBe(false);

    const second = await scanOrThrow(scanner);
    expect(second.changes.some((change) => change.kind === "content-changed")).toBe(false);
    expect(
      second.changes
        .filter((change) => change.current?.readStatus === "ready")
        .every((change) => change.kind === "unchanged"),
    ).toBe(true);
    expect(second.files.map((file) => file.fileId)).toEqual(first.files.map((file) => file.fileId));
  });

  test("classifies metadata, same-size content, additions, deletions, and renames", async () => {
    const original = join(root, "original.txt");
    const coarse = join(root, "coarse.txt");
    await writeFile(original, "alpha");
    await writeFile(coarse, "first");
    const exactSecond = Math.floor(Date.now() / 1_000) - 10;
    await utimes(coarse, exactSecond, exactSecond);
    const manifest = await openManifest();
    const scanner = new RepositoryScanner({ identity: rootIdentity, path: root }, manifest);
    await scanOrThrow(scanner);

    const future = new Date(Date.now() + 5_000);
    await utimes(original, future, future);
    const metadata = await scanOrThrow(scanner);
    expect(metadata.changes.find((change) => change.relativePath === "original.txt")?.kind).toBe(
      "metadata-only",
    );

    const oldStats = await stat(coarse);
    await writeFile(coarse, "other");
    await utimes(coarse, oldStats.atime, oldStats.mtime);
    const content = await scanOrThrow(scanner);
    expect(content.changes.find((change) => change.relativePath === "coarse.txt")?.kind).toBe(
      "content-changed",
    );

    await writeFile(join(root, "added.md"), "added");
    await rename(original, join(root, "renamed.txt"));
    const changed = await scanOrThrow(scanner);
    expect(changed.changes.find((change) => change.relativePath === "added.md")?.kind).toBe(
      "added",
    );
    expect(changed.changes.find((change) => change.relativePath === "original.txt")?.kind).toBe(
      "deleted",
    );
    expect(changed.changes.find((change) => change.relativePath === "renamed.txt")?.kind).toBe(
      "added",
    );
    expect(manifest.snapshot().some((file) => file.relativePath === "original.txt")).toBe(false);

    await unlink(join(root, "added.md"));
    const removed = await scanOrThrow(scanner, "reconcile");
    expect(removed.progress.removed).toBe(1);
    expect(removed.changes.find((change) => change.relativePath === "added.md")?.source).toBe(
      "reconcile",
    );
  });

  test("records an unreadable file without terminating the scan", async () => {
    await writeFile(join(root, "good.txt"), "good");
    const locked = join(root, "locked.txt");
    await writeFile(locked, "locked");
    await chmod(locked, 0o000);
    const scanner = new RepositoryScanner(
      { identity: rootIdentity, path: root },
      await openManifest(),
    );
    const result = await scanOrThrow(scanner);
    expect(result.files.find((file) => file.relativePath === "good.txt")?.readStatus).toBe("ready");
    if (process.getuid?.() !== 0) {
      expect(result.files.find((file) => file.relativePath === "locked.txt")?.readStatus).toBe(
        "unreadable",
      );
      expect(result.progress.failed).toBe(1);
    }
  });

  test("reports per-file and fatal discovery states through the startup store", async () => {
    const outside = join(fixture, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "unsafe.md"));
    const startup = new StartupStateStore({ phase: "scanning", changedAt: 0, issues: [] });
    const scanner = new RepositoryScanner(
      { identity: rootIdentity, path: root },
      await openManifest(),
      { startupState: startup },
    );
    await scanOrThrow(scanner);
    expect(startup.getSnapshot().phase).toBe("indexing");
    expect(startup.getSnapshot().issues).toHaveLength(1);

    const fatalState = new StartupStateStore({ phase: "scanning", changedAt: 0, issues: [] });
    const missingScanner = new RepositoryScanner(
      { identity: rootIdentity, path: join(root, "missing") },
      await openManifest("fatal.json"),
      { startupState: fatalState },
    );
    const fatal = await missingScanner.scan();
    expect(fatal).toMatchObject({ ok: false, error: { code: "DISCOVERY_ROOT_UNAVAILABLE" } });
    expect(fatalState.getSnapshot().phase).toBe("error");
  });

  test("excludes an explicitly supplied canonical state location", async () => {
    const accidentalState = join(root, "app-state");
    await mkdir(accidentalState);
    await writeFile(join(accidentalState, "private.json"), "state");
    await writeFile(join(root, "public.txt"), "public");
    const scanner = new RepositoryScanner(
      { identity: rootIdentity, path: root },
      await openManifest(),
      { excludedCanonicalPaths: [accidentalState] },
    );
    const result = await scanOrThrow(scanner);
    expect(result.files.map((file) => file.relativePath)).toEqual(["public.txt"]);
    expect(await readFile(join(accidentalState, "private.json"), "utf8")).toBe("state");
  });
});
