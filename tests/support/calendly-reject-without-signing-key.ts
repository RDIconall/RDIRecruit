/**
 * Child process: the signing key is absent when the route module loads.
 * Prints one JSON object: { status: number }.
 */
import { NextRequest } from "next/server";

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("missing capture url");
  process.exit(2);
}

delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
process.env.SUPABASE_URL = baseUrl;
process.env.SUPABASE_SERVICE_KEY = "placeholder-supabase-service-key";
process.env.WORKABLE_TOKEN = "placeholder-workable-token";

async function main(): Promise<void> {
  const raw = JSON.stringify({
    event: "invitee.created",
    payload: { email: "ada@example.com", name: "Ada Lovelace" },
  });
  const { POST } = await import("../../src/app/api/hooks/calendly/route.ts");
  const response = await POST(
    new NextRequest("http://127.0.0.1/api/hooks/calendly", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
  console.log(JSON.stringify({ status: response.status }));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
