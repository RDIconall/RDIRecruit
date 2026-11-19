// Next substitutes an empty module for `server-only` in server builds.
// The package itself throws on import; tests load the server entrypoints directly.
export {};
