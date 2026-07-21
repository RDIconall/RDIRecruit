#!/usr/bin/env node
/**
 * Send a Clerk invitation so a user can sign up for RDIRecruit.
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_... node scripts/invite-clerk-user.mjs lara@rditrials.com
 *
 * Optional:
 *   APP_ORIGIN=https://your-app.vercel.app  (defaults to http://localhost:3000)
 */

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/invite-clerk-user.mjs <email>");
  process.exit(1);
}

const secret = process.env.CLERK_SECRET_KEY?.trim();
if (!secret) {
  console.error("CLERK_SECRET_KEY is required.");
  process.exit(1);
}

const origin = (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");

const res = await fetch("https://api.clerk.com/v1/invitations", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email_address: email,
    redirect_url: `${origin}/sign-up`,
    notify: true,
  }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Clerk invitation failed (${res.status}): ${body}`);
  process.exit(1);
}

console.log(`Invitation sent to ${email}.`);
console.log(body);
