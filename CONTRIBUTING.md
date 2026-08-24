# Contributing

Thanks for helping improve Codelit Desktop.

## Before opening a pull request

1. Keep the change within the desktop application boundary.
2. Do not commit credentials, certificates, provisioning profiles, user data,
   model weights, generated bundles, or release artifacts.
3. Add focused tests for behavioral changes.
4. Run the validation commands below.

```bash
npm install
npm run test
npm run desktop:check
npm run desktop:qa:renderer
```

Rust changes must also pass formatting, Clippy with warnings denied, and native
tests. UI changes should include manual verification in both light and dark mode
at compact and full desktop window sizes.

## Pull requests

Keep pull requests focused and explain the user-visible behavior, security
boundary, and verification performed. Changes that weaken exact approvals,
credential isolation, local-data privacy, or release provenance will not be
accepted without a documented replacement control.

By contributing, you agree that your contribution is licensed under MPL-2.0.
