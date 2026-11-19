export async function auth() {
  return { userId: "user_test" };
}

export async function currentUser() {
  return {
    firstName: "Reviewer",
    lastName: "Example",
    emailAddresses: [{ emailAddress: "reviewer@example.com" }],
  };
}
