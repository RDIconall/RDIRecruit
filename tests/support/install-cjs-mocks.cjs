/* eslint-disable @typescript-eslint/no-require-imports */
const { Module, createRequire } = require("node:module");
const path = require("node:path");

const requireFromRepo = createRequire(path.join(__dirname, "..", "..", "package.json"));
const clerkResolved = requireFromRepo.resolve("@clerk/nextjs/server");
const standin = path.join(__dirname, "clerk-session-standin.cjs");
const empty = path.join(__dirname, "empty-module.cjs");
const cacheStandin = path.join(__dirname, "next-cache-standin.cjs");

process.env.WORKABLE_SUBDOMAIN = "rditrials";
process.env.WORKABLE_TOKEN = "placeholder-token";
process.env.WORKABLE_MEMBER_ID = "member_placeholder";
process.env.SUPABASE_URL = "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
process.env.HIRING_ADMIN_EMAILS = "hiring-admin@rditrials.example";

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "@clerk/nextjs/server" || request === clerkResolved) {
    return standin;
  }
  if (request === "server-only") {
    return empty;
  }
  if (request === "next/cache") {
    return cacheStandin;
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
