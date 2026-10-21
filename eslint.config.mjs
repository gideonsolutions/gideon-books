import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".next/**", "node_modules/**", "lib/db/migrations/**", ".data/**", "storage/**", "playwright-report/**", "test-results/**"] },
];

export default eslintConfig;
