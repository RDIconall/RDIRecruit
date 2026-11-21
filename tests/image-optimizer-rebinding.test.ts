import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";

import nextConfig from "../next.config.ts";
import { config as middlewareConfig } from "../src/middleware.ts";

const require = createRequire(import.meta.url);
const { fetchExternalImage, ImageOptimizerCache } = require(
  "next/dist/server/image-optimizer.js",
) as {
  fetchExternalImage: (
    href: string,
    dangerouslyAllowLocalIP: boolean | undefined,
    maximumResponseBody: number | undefined,
    maximumRedirects: number | undefined,
  ) => Promise<unknown>;
  ImageOptimizerCache: {
    validateParams: (
      req: { headers: Record<string, string> },
      query: { url: string; w: string; q: string },
      nextConfig: { images: typeof imageConfigDefault },
      isDev: boolean,
    ) => { href?: string; errorMessage?: string };
  };
};
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js") as {
  imageConfigDefault: {
    remotePatterns: Array<{ protocol?: string; hostname: string }>;
    loader: string;
    unoptimized: boolean;
    dangerouslyAllowLocalIP: boolean;
    maximumResponseBody: number;
    maximumRedirects: number;
    deviceSizes: number[];
    imageSizes: number[];
    qualities: number[];
  };
};
const { isPrivateIp } = require("next/dist/server/is-private-ip.js") as {
  isPrivateIp: (ip: string) => boolean;
};

// Same merge as assignDefaultsAndValidate in next/dist/server/config.js.
const configuredImages = nextConfig.images ?? {};
const images = {
  ...imageConfigDefault,
  ...Object.fromEntries(
    Object.entries(configuredImages).filter(([, value]) => value != null),
  ),
} as typeof imageConfigDefault;

const PUBLIC_IP = "1.2.3.4";
const PRIVATE_V4 = "127.0.0.1";
const PRIVATE_V6 = "::1";

type Address = { address: string; family: 4 | 6 };
type Plan = { next: number; answers: Address[][] };

const originalLookup = dns.lookup;
const originalPromiseLookup = dns.promises.lookup;

function installResolver(plans: Map<string, Plan>): () => void {
  const take = (hostname: string): Address[] => {
    const plan = plans.get(hostname);
    if (!plan) {
      const error = new Error(`ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      throw error;
    }
    const index = Math.min(plan.next, plan.answers.length - 1);
    plan.next += 1;
    return plan.answers[index];
  };

  const lookup = ((
    hostname: string,
    options: dns.LookupOptions | ((error: Error | null, address?: unknown, family?: number) => void),
    callback?: (error: Error | null, address?: unknown, family?: number) => void,
  ) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    try {
      const addresses = take(hostname);
      if (options.all) callback!(null, addresses);
      else callback!(null, addresses[0].address, addresses[0].family);
    } catch (error) {
      callback!(error as Error);
    }
  }) as typeof dns.lookup;

  dns.lookup = lookup;
  dns.promises.lookup = (async (hostname: string, options: dns.LookupOptions = {}) => {
    const addresses = take(hostname);
    if (options.all) return addresses;
    return { address: addresses[0].address, family: addresses[0].family };
  }) as typeof dns.promises.lookup;

  return () => {
    dns.lookup = originalLookup;
    dns.promises.lookup = originalPromiseLookup;
  };
}

function plan(answers: Address[][]): Plan {
  return { next: 0, answers };
}

function v4(address: string): Address {
  return { address, family: 4 };
}

function v6(address: string): Address {
  return { address, family: 6 };
}

async function listen(host: string): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = net.createServer((socket) => {
    hits.push(`${socket.localAddress}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const request = { headers: { accept: "image/webp" } };

function validate(url: string) {
  return ImageOptimizerCache.validateParams(request, { url, w: "640", q: "75" }, { images }, false);
}

let certificateDir: string;

before(() => {
  assert.equal(isPrivateIp(PUBLIC_IP), false);
  assert.equal(isPrivateIp(PRIVATE_V4), true);
  assert.equal(isPrivateIp(PRIVATE_V6), true);
  execFileSync("sudo", ["-n", "/usr/sbin/ip", "addr", "replace", `${PUBLIC_IP}/32`, "dev", "lo"], {
    stdio: "ignore",
  });
  certificateDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-optimizer-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      path.join(certificateDir, "key.pem"),
      "-out",
      path.join(certificateDir, "cert.pem"),
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=proj.supabase.co",
      "-addext",
      "subjectAltName=DNS:proj.supabase.co,IP:1.2.3.4",
    ],
    { stdio: "ignore" },
  );
});

after(() => {
  fs.rmSync(certificateDir, { recursive: true, force: true });
});

test("the image optimizer route is enabled and anonymous", () => {
  assert.equal(images.loader, "default");
  assert.equal(images.unoptimized, false);
  assert.equal(images.dangerouslyAllowLocalIP, false);
  assert.deepEqual(images.remotePatterns, [{ protocol: "https", hostname: "*.supabase.co" }]);

  // tsx rewrites Next's build analyzer, so run the matcher in plain Node.
  const matcherScript = `
    const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
    const { getMiddlewareRouteMatcher } = require("next/dist/shared/lib/router/utils/middleware-route-matcher.js");
    const matchers = getMiddlewareMatchers(${JSON.stringify(middlewareConfig.matcher)}, { basePath: "" });
    const matches = getMiddlewareRouteMatcher(matchers);
    const paths = ["/_next/image", "/candidates"];
    process.stdout.write(JSON.stringify(Object.fromEntries(paths.map((pathname) => [pathname, matches(pathname, { headers: {} }, {})]))));
  `;
  const matcher = spawnSync(process.execPath, ["-e", matcherScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(matcher.status, 0, matcher.stderr);
  const matched = JSON.parse(matcher.stdout) as Record<string, boolean>;
  assert.equal(matched["/_next/image"], false);
  assert.equal(matched["/candidates"], true);

  const allowed = validate("https://rebind.supabase.co/pixel.png");
  assert.equal("errorMessage" in allowed, false);
  const rejected = validate("https://evil.example/pixel.png");
  assert.equal(rejected.errorMessage, '"url" parameter is not allowed');
});

test("an allow-listed name that resolves only to a private address is not contacted", async () => {
  const sink = await listen(PRIVATE_V4);
  const restore = installResolver(
    new Map([["private.supabase.co", plan([[v4(PRIVATE_V4)]])]]),
  );
  try {
    const params = validate(`https://private.supabase.co:${sink.port}/pixel.png`);
    assert.equal("errorMessage" in params, false);
    await assert.rejects(() =>
      fetchExternalImage(
        params.href!,
        images.dangerouslyAllowLocalIP,
        images.maximumResponseBody,
        images.maximumRedirects,
      ),
    );
    assert.deepEqual(sink.hits, []);
  } finally {
    restore();
    await sink.close();
  }
});

test("an allow-listed name whose later lookup is a private IPv4 address is not contacted", async () => {
  const sink = await listen(PRIVATE_V4);
  const restore = installResolver(
    new Map([
      [
        "rebind.supabase.co",
        plan([[v4(PUBLIC_IP)], [v4(PRIVATE_V4)]]),
      ],
    ]),
  );
  try {
    const params = validate(`https://rebind.supabase.co:${sink.port}/pixel.png`);
    assert.equal("errorMessage" in params, false);
    await assert.rejects(() =>
      fetchExternalImage(
        params.href!,
        images.dangerouslyAllowLocalIP,
        images.maximumResponseBody,
        images.maximumRedirects,
      ),
    );
    assert.deepEqual(sink.hits, []);
  } finally {
    restore();
    await sink.close();
  }
});

test("an allow-listed name whose later lookup is a private IPv6 address is not contacted", async () => {
  const sink = await listen(PRIVATE_V6);
  const restore = installResolver(
    new Map([
      [
        "rebind6.supabase.co",
        plan([[v4(PUBLIC_IP)], [v6(PRIVATE_V6)]]),
      ],
    ]),
  );
  try {
    const params = validate(`https://rebind6.supabase.co:${sink.port}/pixel.png`);
    assert.equal("errorMessage" in params, false);
    await assert.rejects(() =>
      fetchExternalImage(
        params.href!,
        images.dangerouslyAllowLocalIP,
        images.maximumResponseBody,
        images.maximumRedirects,
      ),
    );
    assert.deepEqual(sink.hits, []);
  } finally {
    restore();
    await sink.close();
  }
});

test("an allow-listed redirect whose later lookup is a private address is not contacted", async () => {
  const sink = await listen(PRIVATE_V4);
  const redirectTo = `https://rebind.example:${sink.port}/pixel.png`;
  const upstream = tls.createServer(
    {
      key: fs.readFileSync(path.join(certificateDir, "key.pem")),
      cert: fs.readFileSync(path.join(certificateDir, "cert.pem")),
    },
    (socket) => {
      socket.on("data", () => {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: ${redirectTo}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      });
    },
  );
  await new Promise<void>((resolve) => upstream.listen(0, PUBLIC_IP, () => resolve()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const restore = installResolver(
    new Map([
      ["proj.supabase.co", plan([[v4(PUBLIC_IP)]])],
      ["rebind.example", plan([[v4(PUBLIC_IP)], [v4(PRIVATE_V4)]])],
    ]),
  );
  try {
    const params = validate(`https://proj.supabase.co:${upstreamPort}/functions/v1/redir`);
    assert.equal("errorMessage" in params, false);
    await assert.rejects(() =>
      fetchExternalImage(
        params.href!,
        images.dangerouslyAllowLocalIP,
        images.maximumResponseBody,
        images.maximumRedirects,
      ),
    );
    assert.deepEqual(sink.hits, []);
  } finally {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    restore();
    await sink.close();
    await new Promise((resolve) => upstream.close(() => resolve(undefined)));
  }
});

test("an allow-listed redirect to a literal private address is not contacted", async () => {
  const sink = await listen(PRIVATE_V4);
  const redirectTo = `https://${PRIVATE_V4}:${sink.port}/pixel.png`;
  const upstream = tls.createServer(
    {
      key: fs.readFileSync(path.join(certificateDir, "key.pem")),
      cert: fs.readFileSync(path.join(certificateDir, "cert.pem")),
    },
    (socket) => {
      socket.on("data", () => {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: ${redirectTo}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      });
    },
  );
  await new Promise<void>((resolve) => upstream.listen(0, PUBLIC_IP, () => resolve()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const restore = installResolver(new Map([["proj.supabase.co", plan([[v4(PUBLIC_IP)]])]]));
  try {
    const params = validate(`https://proj.supabase.co:${upstreamPort}/functions/v1/redir`);
    assert.equal("errorMessage" in params, false);
    await assert.rejects(() =>
      fetchExternalImage(
        params.href!,
        images.dangerouslyAllowLocalIP,
        images.maximumResponseBody,
        images.maximumRedirects,
      ),
    );
    assert.deepEqual(sink.hits, []);
  } finally {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    restore();
    await sink.close();
    await new Promise((resolve) => upstream.close(() => resolve(undefined)));
  }
});
