const js = require("@eslint/js");
const globals = require("globals");

/*
 * ESLint's recommended rules, tuned for this codebase:
 * - unused arguments are allowed (Express error handlers need all four to be
 *   recognised as error handlers);
 * - unused caught errors are allowed (deliberate "ignore this failure" blocks);
 * - rest siblings are allowed (destructuring a field out to drop it).
 */
module.exports = [
  { ignores: ["node_modules/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      // A catch that only rethrows is harmless; not worth touching
      // transactional code for.
      "no-useless-catch": "warn",
    },
  },
];
