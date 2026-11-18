/**
 * Session stand-in. The actions read auth().userId and, from currentUser(),
 * id, firstName, lastName, and emailAddresses[].emailAddress.
 */
const { harness } = require("./state.cjs");

async function auth() {
  const user = harness().user;
  return { userId: user?.id ?? null };
}

async function currentUser() {
  return harness().user;
}

function clerkMiddleware() {
  return () => {};
}

function createRouteMatcher() {
  return () => false;
}

module.exports = { auth, currentUser, clerkMiddleware, createRouteMatcher };
