async function auth() {
  return { userId: "user_public_signup" };
}

async function currentUser() {
  return {
    id: "user_public_signup",
    firstName: "Stranger",
    lastName: "Signup",
    emailAddresses: [{ emailAddress: "stranger@example.com" }],
  };
}

function clerkMiddleware() {
  return () => undefined;
}

function createRouteMatcher() {
  return () => false;
}

module.exports = { auth, currentUser, clerkMiddleware, createRouteMatcher };
