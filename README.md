# releaselock-action

GitHub Action that checks the `uses:` refs in your workflows against the public [ReleaseLock](https://releaselock.dev) API. It fails or warns when a dependency is not locked down (immutable, attested, or pinned to a full commit SHA), using the bar you set.

The action is dependency-free JavaScript and runs on Node 20. `action.yml` points at `src/index.js`, so the job does not need `npm install` or a bundled `dist/` file.

## Usage

Pin every third-party action to a full 40-character commit SHA. The moving major tag is `v1`. It is listed on the GitHub Marketplace as [ReleaseLock Gate](https://github.com/marketplace/actions/releaselock-gate). In this repo, `uses: ./` runs the action on the commit you checked out. The copy-paste workflow is `docs/example-workflow.yml`.

`actions/checkout` is **Unlocked** in the ReleaseLock directory. A commit pin stops the tag from moving, and it does not change that integrity result. `fail-on: unlocked` still fails a pinned checkout. The example allow-lists `actions/checkout` so the rest of the workflow is held to the unlocked bar. The allow list also skips the SHA pin rule for that repo, so leave the checkout step pinned yourself.

```yaml
name: ReleaseLock
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: ReleaseLock gate
        uses: cassiecrossley/releaselock-action@050a1a6d652d23443ff4add2cd064cbcfd42f856 # v1.0.0
        with:
          fail-on: unlocked
          require-sha-pinning: true
          allow-list: actions/checkout
```

To fail when checkout itself is Unlocked, remove `allow-list`. To enforce SHA pins only, set `fail-on: none`. The example pins v1.0.0 (`050a1a6d652d23443ff4add2cd064cbcfd42f856`). Use `cassiecrossley/releaselock-action@v1` to follow the major line.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `fail-on` | `unlocked` | Integrity bar sent as `fail_on`. See the live bars below. |
| `require-sha-pinning` | `true` | Fail `uses:` refs that are not a full 40-character commit SHA. |
| `allow-list` | empty | Comma-separated `owner/repo` or `owner/repo@ref` exemptions. A match skips integrity and SHA pin failures. Wildcards are not supported. |
| `api-base` | `https://releaselock.dev` | API origin, no trailing slash. |
| `scan-dockerfiles` | `true` | Warn on Dockerfile `ADD`/`COPY` http(s) URLs and `curl` piped to a shell. Warnings do not fail the job. |
| `workflow-glob` | `.github/workflows/*.yml,.github/workflows/*.yaml` | Comma-separated workflow globs, relative to the workspace. |
| `on-failure` | `fail` | `fail` exits non-zero when the policy matches. `warn` records warnings and leaves the job green. API errors still fail the job. |

## Outputs

| Output | Meaning |
|---|---|
| `policy-failed` | `true` or `false` from the scan. Stays `true` when `on-failure` is `warn`. |
| `result-json` | JSON body from `POST /v1/scan/workflows`. |

The step also writes a Markdown table to the job summary, with one row per ref.

## API

Rechecked against the live service at [releaselock.dev](https://releaselock.dev) on 2026-10-29. The gate calls:

`POST https://releaselock.dev/v1/scan/workflows`

```json
{
  "actions": ["actions/checkout@v4"],
  "fail_on": "unlocked",
  "require_sha_pinning": true,
  "allow_list": "actions/checkout"
}
```

The action reads workflow files locally, collects `uses:` values, and posts that list as `actions`. The same endpoint accepts raw workflow YAML in `workflows`: a string, an array of YAML strings, or objects with `path` and `content`. It extracts `uses:` from that YAML. `refs` is another alias for a ref list. When `actions` and `workflows` are both present, `actions` wins.

`require_sha_pinning` accepts a JSON boolean or a string boolean. `"false"`, `"no"`, and `"0"` are false. `"true"` is true. This action sends a JSON boolean.

`allow_list` may be a comma-separated string or a JSON array. `owner/repo` matches every ref of that repository. `owner/repo@ref` matches that ref only. `actions/*` does not match.

### Integrity bars

These are the bars the live API applied, not a ladder assumed by an older scaffold. `policy_failed` on the response is what fails the job. Status ranks seen in responses: Unknown 0, Unlocked 1, Checksums only 2, Signed 3, Attested 4, Immutable 5.

| `fail_on` | What fails the integrity check |
|---|---|
| `none` | Nothing. SHA pinning can still fail. |
| `unlocked` | Unknown, Unlocked, and Checksums only. Signed and above pass. |
| `checksums-only` | Same as `unlocked` today. |
| `signed` | Same as `unlocked` today. Signed does not fail. |
| `attested` | Unknown through Signed. Attested and Immutable pass. |
| `immutable` | Anything that is not Immutable. |
| any other value | HTTP 400 `invalid_fail_on`. Allowed values are `unlocked`, `checksums-only`, `signed`, `attested`, `immutable`, and `none`. An empty `fail_on` still defaults to `unlocked`. |

Aliases `checksums only`, `checksums_only`, and `off` (`none`) are normalized before the request.

Local actions (`./` and `./path`) and `docker://` images are classified by the API and do not fail the policy by themselves. A docker action without `@sha256:` gets a warning. A ref the API cannot parse (for example `actions/checkout` with no `@ref`) is Unknown and fails the unlocked bar.

### Endpoints that are not the gate

`POST /v1/verify` returns 404. `GET /v1/verify/{owner}/{repo}` returns the latest tracked release when no selector is set. `?ref=`, `?tag=`, and `?sha=` all select a release. The response includes `requested_ref`, `ref_tracked`, `matched_by`, and `fallback`. A tracked value matches an exact tag (`matched_by: tag`), a full commit SHA (`sha`), a SHA prefix (`sha_prefix`), or a major version such as `v7` (`major_prefix`). A 7-character prefix of the tracked commit matched. A 4-character prefix did not. An untracked value still returns the latest release with `ref_tracked: false`, `fallback: latest`, and `ref_message`. For `actions/checkout`, `v4` is untracked because the tracked release is `v7.0.1`. The same lookup accepts a path segment (`/v1/verify/actions/checkout/v7` matches `major_prefix`). The gate keeps calling `POST /v1/scan/workflows`, which scores every workflow ref in one request.

`GET /v1/directory` is the public directory behind [releaselock.dev](https://releaselock.dev). `GET /v1/health` reports liveness.

The scan API fails closed on bad input. An empty body or invalid JSON gets HTTP 400 (`empty_body`, `invalid_json`), a non-JSON `Content-Type` gets 415, a body over 1 MB gets 413, and a request with no `uses:` refs to check gets 422 (`no_refs_found`). This action always sends JSON with at least one ref, and it fails the job on any non-2xx response.

## Tests

This repository has no `.github/workflows` directory, which GitHub Marketplace requires. Run the unit tests locally with `node --test`. A consumer workflow example is in `docs/example-workflow.yml`.

## Local checks

```bash
node --test
```

Scan the current workspace:

```bash
INPUT_FAIL-ON=none \
INPUT_REQUIRE-SHA-PINNING=true \
node src/index.js
```

## License

MIT. Copyright (c) 2026 Cassie Crossley.
