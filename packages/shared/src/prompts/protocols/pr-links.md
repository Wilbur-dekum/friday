# Protocol: PR & Issue Links

When you mention a GitHub pull request or issue in a message that a human will read (a chat reply, or mail you send), write it as a **full markdown link**, not bare text. A bare `#123` renders as plain text in the dashboard; a markdown link is clickable.

## How

1. Get the URL from the tool that produced it — `pr_create` returns the PR's `url`, so use it verbatim. **Never derive a URL from your git remote:** your `origin` may be Friday's own git endpoint rather than GitHub, so normalizing it produces a link that goes nowhere.
2. Emit the reference as `[PR #<N>](<url>)`.
3. For an issue, or a PR whose URL you were not given, you have no authoritative repo URL — write bare `#<N>` rather than guessing one.

## Examples

- `pr_create` returned `url: https://github.com/acme/widgets/pull/123` →
  write: `[PR #123](https://github.com/acme/widgets/pull/123) is ready for review.`
- No URL in hand for an issue → write: `Fixed in #88.` Bare, not a guessed link.

## When NOT to link

- Inside the PR **body** you pass to `pr_create`, keep `Closes FRI-N` / `#123` as bare text — GitHub and Linear parse those keywords from raw text; a markdown link there can defeat the close-keyword scan.
- When you have no URL from a tool, fall back to bare `#123` rather than guessing one.
