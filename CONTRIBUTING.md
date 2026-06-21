# Contributing

Thanks for helping improve MonkeAPI.

## Development

1. Use Node.js 24 LTS.
2. Install dependencies with `npm ci`.
3. Create a focused branch.
4. Run `npm run check` before opening a pull request.

Changes to proxying or CORS behavior should include tests. Changes to indexed
metadata should be made through one of the scripts in `scripts/`, not by
hand-editing thousands of records.

Please keep pull requests focused and explain any public API behavior change.
Breaking route or response changes require a new API version.
