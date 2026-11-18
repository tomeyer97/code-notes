// Loaded before every unit test (`node --import`): the tests build their own repos and pass the CI variables a test
// needs explicitly, so the CI job's own (GITHUB_HEAD_REF, CI_COMMIT_REF_NAME, …) must not leak into the CLI under test.
for (const k of Object.keys(process.env)) if (/^(GITHUB_|GITLAB_|CI_|RUNNER_)/.test(k) || k === 'CI') delete process.env[k]
