# Contributing to Automata

First off, thank you for considering contributing to Automata! It's people like you that make open-source a great community.

## Getting Started

1. **Fork the Repository:** Fork the project on GitHub.
2. **Clone:** Clone your fork locally.
3. **Install Dependencies:** `npm install`
4. **Initialize DB:** Run `npm run db:init` to set up the local Cloudflare D1 SQLite database.
5. **Environment Variables:** Create a `.dev.vars` file based on the prerequisites in the `README.md`.

## Development Workflow

- Run the local dev server using `npm run dev`.
- Ensure unit tests pass with `npm test`, Cloudflare runtime tests pass with
  `npm run test:runtime`, and code is linted with `npm run lint`.
- See `docs/RUNTIME_TESTING.md` before adding or changing a runtime test.
- For formatting, this project uses Prettier. Please ensure your code is formatted before submitting a PR.

## Submitting a Pull Request

1. Create a new branch from `main` (e.g., `feature/awesome-new-thing`).
2. Make your changes and commit them with descriptive messages.
3. Run `npm run verify` and ensure all CI checks pass.
4. Submit a PR and fill out the Pull Request Template.

We welcome all contributions, from bug fixes to feature additions and documentation improvements.
