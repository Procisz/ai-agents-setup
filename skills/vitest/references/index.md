# Vitest reference index

Vitest is a next-generation testing framework powered by Vite. It provides a Jest-compatible API with native ESM, TypeScript, and JSX support out of the box. Vitest shares the same config, transformers, resolvers, and plugins with your Vite app.

**Key Features:**
- Vite-native: Uses Vite's transformation pipeline for fast HMR-like test updates
- Jest-compatible: Drop-in replacement for most Jest test suites
- Smart watch mode: Only reruns affected tests based on module graph
- Native ESM, TypeScript, JSX support without configuration
- Multi-threaded workers for parallel test execution
- Built-in coverage via V8 or Istanbul
- Snapshot testing, mocking, and spy utilities

> The skill is based on Vitest 5.1.0-beta.1, generated at 2026-10-23.

## Core

| Topic | Description | Reference |
|-------|-------------|-----------|
| Configuration | Vitest and Vite config integration, defineConfig usage | [core-config](core-config.md) |
| CLI | Command line interface, commands and options | [core-cli](core-cli.md) |
| Test API | test/it function, modifiers like skip, only, concurrent | [core-test-api](core-test-api.md) |
| Describe API | describe/suite for grouping tests and nested suites | [core-describe](core-describe.md) |
| Expect API | Assertions with toBe, toEqual, matchers and asymmetric matchers | [core-expect](core-expect.md) |
| Hooks | beforeEach, afterEach, beforeAll, afterAll, aroundEach | [core-hooks](core-hooks.md) |

## Features

| Topic | Description | Reference |
|-------|-------------|-----------|
| Mocking | Mock functions, modules, timers, dates with vi utilities | [features-mocking](features-mocking.md) |
| Snapshots | Snapshot testing with toMatchSnapshot and inline snapshots | [features-snapshots](features-snapshots.md) |
| Coverage | Code coverage with V8 or Istanbul providers | [features-coverage](features-coverage.md) |
| Test Context | Test fixtures, context.expect, test.extend for custom fixtures | [features-context](features-context.md) |
| Concurrency | Concurrent tests, parallel execution, sharding | [features-concurrency](features-concurrency.md) |
| Filtering | Filter tests by name, file patterns, tags | [features-filtering](features-filtering.md) |
| Test Tags | Label tests with tags to filter runs and apply shared options | [features-test-tags](features-test-tags.md) |
| Reporters | Built-in reporters, default selection, CI/output config | [features-reporters](features-reporters.md) |
| Benchmarking | Write benchmarks with the bench fixture (Tinybench) | [features-benchmarking](features-benchmarking.md) |

## Advanced

| Topic | Description | Reference |
|-------|-------------|-----------|
| Vi Utilities | vi helper: mock, spyOn, fake timers, hoisted, waitFor | [advanced-vi](advanced-vi.md) |
| Environments | Test environments: node, jsdom, happy-dom, custom | [advanced-environments](advanced-environments.md) |
| Type Testing | Type-level testing with expectTypeOf and assertType | [advanced-type-testing](advanced-type-testing.md) |
| Projects | Multi-project workspaces, different configs per project | [advanced-projects](advanced-projects.md) |
