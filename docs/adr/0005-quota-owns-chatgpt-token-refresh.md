# Quota extension refreshes the ChatGPT token itself

The Quota extension reads the `openai-codex` OAuth entry from pi's
`~/.pi/agent/auth.json` and, when the access token is expired, refreshes it
through the same endpoint and client id pi's bundled OAuth uses
(`POST https://auth.openai.com/oauth/token`, `grant_type=refresh_token`),
then writes the new token pair back to `auth.json`.

pi itself only refreshes the token when the openai-codex model is actually in
use, so a session running another provider would sit on an expired token.
Reading Codex CLI's `~/.codex/auth.json` was rejected: it couples the
extension to a tool that may not be installed or run, and a token refreshed
there would not flow back to pi. Duplicating pi's refresh is the price of the
extension working from any session.

Because both pi and the extension can refresh the same login, and ChatGPT
refresh tokens rotate, the extension refreshes only on expiry or 401, does a
read-modify-write on `auth.json`, and retries once after re-reading before
declaring the login dead and asking the user to log in again.
