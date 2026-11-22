async function auth() {
  return { userId: "user_test" };
}
async function currentUser() {
  return { firstName: "Test", lastName: "Reviewer", emailAddresses: [{ emailAddress: "reviewer@example.test" }] };
}
function clerkMiddleware() {
  return () => {};
}
module.exports = { auth, currentUser, clerkMiddleware };
