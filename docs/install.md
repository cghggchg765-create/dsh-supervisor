# Install

This page installs the payload into a DeepSeek Harness checkout at the matching tag. The `@deepseek-ai/dsh-*` packages this payload depends on are not published to npm, so there is no registry install; the payload is an in-tree overlay.

Every command below is run from a shell. `<this repo>` is the absolute path of this repository; `<harness>` is the absolute path of the harness checkout.

## Prerequisites

- Node `^22.19 || >=24` and pnpm.
- git.
- The harness at tag `dsh-v0.1.7-rc.1`.

## 1. Clone the harness at the matching tag

```sh
git clone --depth 1 --branch dsh-v0.1.7-rc.1 https://github.com/deepseek-ai/deepseek-harness.git <harness>
cd <harness>
```

## 2. Copy the payload in

```sh
mkdir -p <harness>/packages/supervisor
cp -R "<this repo>/packages/supervisor/." <harness>/packages/supervisor/
```

The result is `<harness>/packages/supervisor/{supervisor,supervisor-core,supervisor-tasks,supervisor-orchestration,supervisor-ops,supervisor-pacing,supervisor-shutdown}`, one package per directory, exactly as the harness lays out `packages/<group>/<pkg>`.

## 3. Register the payload in the harness TypeScript project

The harness resolves workspace packages to their `src/` through the `paths` map in `tsconfig.base.json`, and builds them through the project references in `tsconfig.host.json`. The payload carries no built `lib/`, so without this registration neither `vitest` nor the loader-composition subprocesses can resolve `@deepseek-ai/dsh-supervisor-*` from a clean checkout. Apply the checked-in patch, which adds the seven `paths` entries and the seven project references:

```sh
git apply "<this repo>/integration/harness-tsconfig.patch"
```

The patch applies to a clean checkout of `dsh-v0.1.7-rc.1`; if it rejects, the corresponding entries already exist or the checkout is not at the tag.

## 4. Install

```sh
pnpm install
```

pnpm discovers the copied packages through the workspace globs (`packages/*/*`), links them, and updates the lockfile.

## 5. Mount the bundle in a profile

The bundle package is `@deepseek-ai/dsh-supervisor`. Its `dsh.bundle.patch` is `./cordis.patch.yml`, which inserts six rows:

| Row id | Package |
|---|---|
| `supervisor` | `@deepseek-ai/dsh-supervisor-core` |
| `supervisor-tasks` | `@deepseek-ai/dsh-supervisor-tasks` |
| `supervisor-orchestration` | `@deepseek-ai/dsh-supervisor-orchestration` |
| `supervisor-ops` | `@deepseek-ai/dsh-supervisor-ops` |
| `supervisor-pacing` | `@deepseek-ai/dsh-supervisor-pacing` |
| `supervisor-shutdown` | `@deepseek-ai/dsh-supervisor-shutdown` |

Install it into a profile from the running application's Plugins page (Add plugin, then the absolute directory), or from the command line:

```sh
pnpm dsh plugin --profile <name> add "<harness>/packages/supervisor/supervisor"
```

The command forwards `add` to pnpm in the profile directory (`$DSH_HOME/profiles/<name>`): it adds a `link:` dependency on the absolute directory, appends `@deepseek-ai/dsh-supervisor` to `dsh.profile.bundles` in that profile's `package.json`, and enables it. The Electron desktop profile is managed exclusively by the desktop application; install there from its Plugins page instead.

## 6. Give the composition a terminal backend

The bundle never opens a terminal itself. A profile that mounts it needs the harness terminal rows, for example in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        shellDialect: pwsh
    - id: tool-terminal
      name: '@deepseek-ai/dsh-tool-terminal'
```

Without those rows the core component stays pending on a missing service and registers none of its tools; only the boot log carries the warning.

## 7. Set the shared state directory

The six rows share one state directory. Set it in the profile patch, with absolute paths:

```yaml
- id: supervisor
  config:
    stateDir: '/absolute/path/to/state'
    workspaceDir: '/absolute/path/to/workspace'
```

Left unset, `stateDir` resolves to `.supervisor` under the process working directory (for the desktop application, the profile directory), and a checkpoint would then commit whatever repository contains the profile.

Two rules apply to every row: a patch replaces the targeted row's whole `config` rather than merging into it, so restate every key you keep, and the row ids above are the only handles a profile patch has on the components.

## 8. Launch

```sh
pnpm dsh --profile <name> "task"
```

From an installed harness, the same line without `pnpm`:

```sh
dsh --profile <name> "task"
```

## Switching one component off

Disable the component's row id in the profile patch; the other five keep working and only the disabled component's tools leave the next request:

```yaml
- id: supervisor-shutdown
  disabled: true
```

Disabling the bundle row itself (`- id: supervisor` plus the profile's `dsh.profile.bundles` entry) leaves nothing mounted.

## Verify the install

From the harness checkout root:

```sh
pnpm exec vitest run packages/supervisor
pnpm run constraints
```

The first command runs every component's unit and loader-composition tests; the second re-checks the workspace package invariants with the copied packages in place. `.github/workflows/integration.yml` runs exactly these steps against a clean clone.
