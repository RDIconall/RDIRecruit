import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-4">
      <SignUp
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "shadow-lg border border-navy/10",
            headerTitle: "text-navy",
            headerSubtitle: "text-navy/70",
            formButtonPrimary:
              "bg-orange hover:bg-orange-muted text-white",
          },
        }}
      />
    </div>
  );
}
