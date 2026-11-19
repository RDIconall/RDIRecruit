/**
 * Stand-in for @clerk/nextjs/server auth() and currentUser(), shaped from the
 * copies this repo installs:
 * - @clerk/backend 3.7.0 signedInAuthObject / signedOutAuthObject
 *   (node_modules/@clerk/backend/dist/internal.js)
 * - userId comes from the session JWT `sub` claim
 *   (@clerk/shared 4.17.1 jwtPayloadParser.js)
 * - auth.protect() with no role/permission/org argument accepts any userId
 *   (@clerk/nextjs 7.5.2 dist/esm/server/protect.js)
 * - currentUser() returns null when auth() has no userId, otherwise
 *   users.getUser(that same userId)
 *   (@clerk/nextjs 7.5.2 dist/esm/app-router/server/currentUser.js)
 * - User.emailAddresses is the array the app already reads at [0]
 *   (@clerk/backend 3.7.0 User constructor, internal.js)
 *
 * orgId and orgRole stay null: nothing in this app's middleware passes a role
 * to protect(), and a session JWT without an org claim has no orgRole.
 */

const state = {
  userId: null,
  email: null,
  firstName: null,
  lastName: null,
  throwOnCurrentUser: false,
};

function resetSession(next = {}) {
  state.userId = null;
  state.email = null;
  state.firstName = null;
  state.lastName = null;
  state.throwOnCurrentUser = false;
  Object.assign(state, next);
}

async function auth() {
  if (!state.userId) {
    return {
      tokenType: "session_token",
      userId: null,
      orgId: null,
      orgRole: null,
      isAuthenticated: false,
    };
  }
  return {
    tokenType: "session_token",
    userId: state.userId,
    orgId: null,
    orgRole: null,
    isAuthenticated: true,
    sessionClaims: { sub: state.userId },
  };
}

async function currentUser() {
  if (!state.userId) return null;
  if (state.throwOnCurrentUser) {
    throw new Error("clerk user fetch failed");
  }
  return {
    id: state.userId,
    firstName: state.firstName,
    lastName: state.lastName,
    emailAddresses: state.email ? [{ id: "idn_email", emailAddress: state.email }] : [],
    primaryEmailAddressId: state.email ? "idn_email" : null,
  };
}

module.exports = { auth, currentUser, resetSession, sessionState: state };
