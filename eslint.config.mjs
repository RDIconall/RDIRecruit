import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "archive/**",
      ".cursor/**",
      ".next/**",
      "cursor-handoff/**",
      "node_modules/**",
      "spec/**",
      "supabase/.temp/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
