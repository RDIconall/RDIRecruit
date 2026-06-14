#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> RDIRecruit Vercel bootstrap"
echo

if ! command -v vercel >/dev/null 2>&1; then
  echo "Installing Vercel CLI..."
  npm i -g vercel
fi

echo "1. Authenticate (opens browser if needed)"
vercel whoami || vercel login

echo
echo "2. Link or create project 'rdi-recruit'"
vercel link --yes --project rdi-recruit 2>/dev/null || vercel link --yes

echo
echo "3. Add Clerk from Vercel Marketplace (auto-provisions auth env vars)"
echo "   Run: vercel integration add clerk"
echo "   Or install from https://vercel.com/marketplace/clerk"
echo

echo "4. Add Supabase (recommended for this app)"
echo "   Create a project at https://supabase.com and add env vars:"
echo "   SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY"
echo "   Then run migration: supabase/migrations/001_initial_schema.sql"
echo

echo "5. Pull env locally"
vercel env pull .env.local --yes

echo
echo "6. Deploy preview"
vercel deploy --yes

echo
echo "7. Deploy production (when ready)"
echo "   vercel deploy --prod --yes"
echo
echo "Done. Configure Workable webhook -> https://<your-domain>/api/hooks/workable"
