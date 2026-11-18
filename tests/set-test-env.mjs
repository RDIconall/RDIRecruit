process.env.SUPABASE_URL ??= "http://127.0.0.1";
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key-placeholder";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
