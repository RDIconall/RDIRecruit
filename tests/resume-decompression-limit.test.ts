import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startFixtureServer } from "./resume-zip-bomb/fake-supabase.mjs";
import {
  BOMB_ENTRY_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  buildDocx,
  documentXml,
  repeatedBytes,
} from "./resume-zip-bomb/zip-docx";

/**
 * Spec for the résumé zip-bomb: mammoth/jszip inflate every Word part with no
 * cap, and a failed ingest leaves resume_storage_path null so backfill retries
 * it. These tests fail until both are fixed. A normal short .docx must still
 * extract.
 *
 * The address-space ceiling is this machine's stand-in for the serverless
 * memory limit. It is set from a benign run plus a slack that fits a 20 MiB
 * streaming cap and does not fit a 96 MiB inflate.
 */

const require = createRequire(import.meta.url);
const esbuild = require("esbuild") as typeof import("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "tests/resume-zip-bomb/install-fetch.mjs");
const MEMORY_SLACK_KB = 72 * 1024;
const ADDRESS_SLACK_KB = 100 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const BENIGN_TEXT = "Jane Candidate built hiring tools at Northwind.";

const dir = mkdtempSync(path.join(tmpdir(), "resume-zip-"));
const bundles = {
  extract: path.join(dir, "extract.cjs"),
  backfill: path.join(dir, "backfill.cjs"),
  rubric: path.join(dir, "rubric.cjs"),
};
const files = {
  benign: path.join(dir, "benign.docx"),
  honest: path.join(dir, "honest.docx"),
  forged: path.join(dir, "forged.docx"),
  footnotes: path.join(dir, "footnotes.docx"),
  sum: path.join(dir, "sum.docx"),
  innocent: path.join(dir, "innocent.docx"),
};

let benignPeak: { hwmKB: number; vmPeakKB: number } | null = null;

function atAliasPlugin(): import("esbuild").Plugin {
  return {
    name: "at-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const base = path.join(ROOT, "src", args.path.slice(2));
        const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
        return { path: candidates.find((candidate) => existsSync(candidate)) ?? base };
      });
    },
  };
}

async function bundle(entry: string, outfile: string, extraAlias: Record<string, string> = {}) {
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    target: "node22",
    plugins: [atAliasPlugin()],
    alias: extraAlias,
    logLevel: "silent",
  });
}

function writeDocx(file: string, parts: Parameters<typeof buildDocx>[0]) {
  writeFileSync(file, buildDocx(parts));
}

interface Probe {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json: {
    ok?: boolean;
    textLength?: number;
    text?: string;
    error?: string | null;
    hwmKB?: number;
    vmPeakKB?: number;
    fatal?: string;
    results?: unknown[];
  } | null;
}

function runNode(
  bundle: string,
  args: string[],
  opts?: { ulimitKB?: number; env?: NodeJS.ProcessEnv; hook?: boolean },
): Probe {
  const nodeArgs = [...(opts?.hook ? ["--import", HOOK] : []), bundle, ...args];
  const env = { ...baseEnv(), ...opts?.env };
  const result = opts?.ulimitKB
    ? spawnSync(
        "bash",
        ["-c", 'ulimit -v "$1"; shift; exec "$@"', "bash", String(opts.ulimitKB), process.execPath, ...nodeArgs],
        { encoding: "utf8", env, timeout: 45_000 },
      )
    : spawnSync(process.execPath, nodeArgs, { encoding: "utf8", env, timeout: 45_000 });
  const stdout = result.stdout ?? "";
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((row) => row.startsWith("{"));
  return {
    status: result.status,
    signal: result.signal,
    stdout,
    stderr: result.stderr ?? "",
    json: line ? (JSON.parse(line) as Probe["json"]) : null,
  };
}

function assertBounded(probe: Probe, benignHwm: number, label: string) {
  const detail = `${label}\nstatus=${probe.status} signal=${probe.signal}\nstdout=${probe.stdout.slice(-400)}\nstderr=${probe.stderr.slice(-400)}`;
  assert.equal(probe.status, 0, detail);
  assert.ok(probe.json, detail);
  assert.equal(probe.json?.ok, false, detail);
  assert.equal(probe.json?.textLength ?? 0, 0, detail);
  const growth = (probe.json?.hwmKB ?? 0) - benignHwm;
  assert.ok(
    growth < MEMORY_SLACK_KB,
    `${detail}\nVmHWM grew ${growth}KB; cap is ${MEMORY_SLACK_KB}KB above a normal résumé`,
  );
}

function workableCandidate(id: string, name: string, resumeUrl: string) {
  return {
    id,
    name,
    firstname: name,
    lastname: "Applicant",
    headline: "",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: "JOB1", title: "Role" },
    stage: "Applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://example.invalid/candidate",
    address: "",
    phone: "",
    email: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    resume_url: resumeUrl,
    answers: [],
    experience_entries: [],
    education_entries: [],
    tags: [],
  };
}

test.before(async () => {
  await bundle(path.join(ROOT, "tests/resume-zip-bomb/extract-entry.ts"), bundles.extract);
  await bundle(path.join(ROOT, "tests/resume-zip-bomb/backfill-entry.ts"), bundles.backfill);
  await bundle(path.join(ROOT, "tests/resume-zip-bomb/rubric-entry.ts"), bundles.rubric, {
    "@clerk/nextjs/server": path.join(ROOT, "tests/resume-zip-bomb/stubs/clerk-server.ts"),
    "next/cache": path.join(ROOT, "tests/resume-zip-bomb/stubs/next-cache.ts"),
    "server-only": path.join(ROOT, "tests/resume-zip-bomb/stubs/empty.ts"),
  });

  const benignXml = documentXml(BENIGN_TEXT);
  writeDocx(files.benign, [{ name: "word/document.xml", data: benignXml }]);
  writeDocx(files.innocent, [{ name: "word/document.xml", data: benignXml }]);
  writeDocx(files.honest, [{ name: "word/document.xml", data: documentXml(repeatedBytes(BOMB_ENTRY_BYTES)) }]);
  writeDocx(files.forged, [
    {
      name: "word/document.xml",
      data: documentXml(repeatedBytes(BOMB_ENTRY_BYTES, 0x42)),
      declaredUncompressedSize: 64,
    },
  ]);
  writeDocx(files.footnotes, [
    { name: "word/document.xml", data: documentXml("Hello") },
    { name: "word/footnotes.xml", data: documentXml(repeatedBytes(BOMB_ENTRY_BYTES, 0x43)) },
  ]);
  const half = 12 * 1024 * 1024;
  writeDocx(files.sum, [
    { name: "word/document.xml", data: documentXml(repeatedBytes(half, 0x44)) },
    { name: "word/footnotes.xml", data: documentXml(repeatedBytes(half, 0x45)) },
  ]);

  const benign = runNode(bundles.extract, [files.benign, "docx"]);
  assert.equal(benign.status, 0, benign.stderr.slice(-500));
  assert.equal(benign.json?.ok, true);
  assert.match(benign.json?.text ?? "", /Jane Candidate/);
  benignPeak = { hwmKB: benign.json?.hwmKB ?? 0, vmPeakKB: benign.json?.vmPeakKB ?? 0 };
  assert.ok(benignPeak.vmPeakKB > 0);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("extracts a normal short Word résumé", () => {
  assert.ok(benignPeak);
  assert.ok(MAX_UNCOMPRESSED_BYTES < BOMB_ENTRY_BYTES);
});

test("rejects a docx whose document.xml inflates past the cap", () => {
  const probe = runNode(bundles.extract, [files.honest, "docx"]);
  assertBounded(probe, benignPeak!.hwmKB, "honest document.xml");
});

test("rejects a docx whose declared uncompressed size is forged small", () => {
  const probe = runNode(bundles.extract, [files.forged, "docx"]);
  assertBounded(probe, benignPeak!.hwmKB, "forged document.xml");
  assert.notEqual(probe.json?.error, "Bug : uncompressed data size mismatch");
});

test("rejects the same bomb when the upload extension is .doc", () => {
  const probe = runNode(bundles.extract, [files.honest, "doc"]);
  assertBounded(probe, benignPeak!.hwmKB, "honest .doc extension");
});

test("rejects a docx whose footnotes part inflates past the cap", () => {
  const probe = runNode(bundles.extract, [files.footnotes, "docx"]);
  assertBounded(probe, benignPeak!.hwmKB, "footnotes.xml");
});

test("rejects a docx whose parts are each under the cap but together are over it", () => {
  const probe = runNode(bundles.extract, [files.sum, "docx"]);
  const detail = `status=${probe.status}\n${probe.stdout.slice(-300)}\n${probe.stderr.slice(-300)}`;
  assert.equal(probe.status, 0, detail);
  assert.equal(probe.json?.ok, false, detail);
  assert.ok((probe.json?.textLength ?? 0) < 1000, detail);
});

test("a bounded parser survives an address-space ceiling that a full inflate does not", () => {
  const limit = benignPeak!.vmPeakKB + ADDRESS_SLACK_KB;
  const probe = runNode(bundles.extract, [files.honest, "docx"], { ulimitKB: limit });
  assertBounded(probe, benignPeak!.hwmKB, `ulimitKB=${limit}`);
});

test("extracts a normal short rubric docx", () => {
  const probe = runNode(bundles.rubric, [files.benign, "rubric.docx"]);
  const detail = `${probe.stdout.slice(-400)}\n${probe.stderr.slice(-400)}`;
  assert.equal(probe.status, 0, detail);
  assert.equal(probe.json?.ok, true, detail);
  assert.match(probe.json?.text ?? "", /Jane Candidate/);
});

test("rejects a rubric docx under the 5MB upload check whose document inflates past the cap", () => {
  const benign = runNode(bundles.rubric, [files.benign, "rubric.docx"]);
  const probe = runNode(bundles.rubric, [files.honest, "bomb.docx"]);
  assert.ok((readFileSync(files.honest).length ?? 0) < 5_000_000);
  assertBounded(probe, benign.json?.hwmKB ?? benignPeak!.hwmKB, "rubric bomb");
});

test("backfill does not keep re-downloading a résumé that fails inflation", async () => {
  const live = await fixture({
    "bomb.docx": readFileSync(files.forged),
    "innocent.docx": readFileSync(files.innocent),
  });
  try {
    live.load(queue(live.url, ["bomb", "innocent"]));
    const probe = runNode(bundles.backfill, ["4"], {
      hook: true,
      env: childEnv(live.url, writeConfig(live.url)),
    });
    const snap = live.snapshot();
    const detail = `${probe.stdout.slice(-800)}\n${probe.stderr.slice(-800)}\n${JSON.stringify(snap.downloads)} uploads=${snap.uploads.length}`;
    assert.equal(probe.status, 0, detail);
    const bomb = snap.applications.find((row: { candidate_id?: string }) => row.candidate_id === "bomb");
    const innocent = snap.applications.find((row: { candidate_id?: string }) => row.candidate_id === "innocent");
    assert.equal(bomb?.resume_storage_path ?? null, null, detail);
    assert.ok(!snap.uploads.some((item: string) => item.includes("bomb")), detail);
    assert.ok((snap.downloads["bomb.docx"] ?? 0) <= 3, detail);
    assert.equal(snap.downloads["innocent.docx"] ?? 0, 1, detail);
    assert.match(String(innocent?.resume_text ?? ""), /Jane Candidate/, detail);
  } finally {
    await live.close();
  }
});

test("one over-limit résumé does not stop the backfill from storing the next candidate", async () => {
  const calm = await fixture({ "innocent.docx": readFileSync(files.innocent) });
  let backfillPeak = 0;
  try {
    calm.load(queue(calm.url, ["innocent"]));
    const probe = runNode(bundles.backfill, ["1"], {
      hook: true,
      env: childEnv(calm.url, writeConfig(calm.url)),
    });
    assert.equal(probe.status, 0, `${probe.stderr.slice(-600)}\n${probe.stdout.slice(-600)}`);
    backfillPeak = probe.json?.vmPeakKB ?? 0;
    assert.ok(backfillPeak > 0);
    assert.match(storedText(calm, "innocent"), /Jane Candidate/);
  } finally {
    await calm.close();
  }

  const live = await fixture({
    "bomb.docx": readFileSync(files.honest),
    "innocent.docx": readFileSync(files.innocent),
  });
  try {
    live.load(queue(live.url, ["bomb", "innocent"]));
    const limit = backfillPeak + ADDRESS_SLACK_KB;
    const probe = runNode(bundles.backfill, ["1"], {
      hook: true,
      ulimitKB: limit,
      env: childEnv(live.url, writeConfig(live.url)),
    });
    const snap = live.snapshot();
    const bomb = snap.applications.find((row: { candidate_id?: string }) => row.candidate_id === "bomb");
    const detail = `ulimitKB=${limit} status=${probe.status} signal=${probe.signal}\n${probe.stdout.slice(-500)}\n${probe.stderr.slice(-400)}\n${JSON.stringify(snap.downloads)}`;
    assert.equal(probe.status, 0, detail);
    assert.equal(bomb?.resume_storage_path ?? null, null, detail);
    assert.match(storedText(live, "innocent"), /Jane Candidate/, detail);
  } finally {
    await live.close();
  }
});

function fixture(bodies: Record<string, Buffer>) {
  const filesForServer: Record<string, { mime: string; body: Buffer }> = {};
  for (const [name, body] of Object.entries(bodies)) {
    filesForServer[name] = { mime: DOCX_MIME, body };
  }
  return startFixtureServer({
    files: filesForServer,
    rows: { candidates: [], applications: [] },
  });
}

function queue(base: string, ids: string[]) {
  const names: Record<string, string> = {
    bomb: "Bomb Applicant",
    innocent: "Innocent Applicant",
  };
  return {
    candidates: ids.map((id) => ({
      workable_id: id,
      job_shortcode: "JOB1",
      name: names[id],
      analysis_hash: null,
      workable_updated_at: "2020-01-01T00:00:00.000Z",
      photo_url: null,
    })),
    applications: ids.map((id) => ({
      candidate_id: id,
      resume_url: `${base}/files/${id}.docx`,
      resume_storage_path: null,
      resume_text: null,
      answers: {},
      cover_letter: null,
    })),
  };
}

function storedText(server: { snapshot: () => { applications: Array<{ candidate_id?: string; resume_text?: string | null }> } }, id: string) {
  return String(server.snapshot().applications.find((row) => row.candidate_id === id)?.resume_text ?? "");
}

function writeConfig(base: string): string {
  const configPath = path.join(dir, `fixture-${base.replace(/\W/g, "")}.json`);
  const people: Array<[string, string]> = [
    ["bomb", "Bomb Applicant"],
    ["innocent", "Innocent Applicant"],
  ];
  const candidates: Record<string, unknown> = {};
  for (const [id, name] of people) {
    const file = id === "bomb" ? "bomb.docx" : "innocent.docx";
    candidates[id] = workableCandidate(id, name, `${base}/files/${file}`);
  }
  // A calibration run has no bomb file. getCandidate is only called for rows
  // the backfill query returns, so an extra map entry is unused.
  writeFileSync(configPath, JSON.stringify({ candidates }));
  return configPath;
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    NODE_PATH: path.join(ROOT, "node_modules"),
  };
}

function childEnv(base: string, configPath: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    SUPABASE_URL: base,
    SUPABASE_SERVICE_KEY: "placeholder-service-key",
    WORKABLE_TOKEN: "placeholder-workable-token",
    FIXTURE_CONFIG: configPath,
  };
}
