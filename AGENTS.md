# Coding principles

- DRY: no duplicated logic or data — one place to change means one place to look
- KISS: prefer the simplest solution that works; complexity must justify itself
- Separation of Concerns: each module, function, and class does one thing
- Single Source of Truth: constants, config, and derived values live in exactly one place
- Testability: write code that can be tested in isolation; avoid hidden global state and hard-coded side effects
- Modern language standards: use current idioms and stdlib features; avoid legacy patterns
- Extract complex types: give non-trivial types (nested dicts, tuples, unions) a named type alias or dataclass

## Tests

- New functionality MUST include new meaningful automated regression tests. Updating only existing tests is insufficient.
- For UI changes, add visual/screenshot regression coverage when it can meaningfully verify the behavior; otherwise cover the new behavior with appropriate automated UI tests.

## Git and CI

- By default, after completing requested application changes and required verification, commit and push the intended changes, then deploy using the documented production process. Do not deploy before verification; verify the live release before declaring the work done.
- Watch the GitHub Actions workflow through completion after every push, investigate and fix failures before declaring the work done, and report explicitly if workflow status cannot be observed.
