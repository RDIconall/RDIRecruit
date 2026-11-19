import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fake = require("./fake-supabase.cjs");

export const getServiceSupabase = fake.getServiceSupabase;
export const getAnonSupabase = fake.getAnonSupabase;
export const resetDb = fake.resetDb;
export const tableRows = fake.tableRows;
