async function auth() {
  return { userId: "user_signed_in" };
}

async function currentUser() {
  return {
    id: "user_signed_in",
    firstName: "Riley",
    lastName: "Quinn",
    emailAddresses: [{ emailAddress: "riley@example.com" }],
  };
}

module.exports = { auth, currentUser };
