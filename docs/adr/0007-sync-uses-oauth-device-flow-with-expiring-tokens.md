# Sync authenticates with the OAuth device flow and expiring tokens

The Gist Backend needs a GitHub credential that can only touch gists, and the
first run on a device must not ask the user to read token documentation, pick
scopes, or handle a secret by hand. We decided to issue the credential through
GitHub's OAuth device flow: the tool shows a one-time code at
`github.com/login/device`, and when the user enters it, GitHub hands the tool
a token limited to the `gist` scope. The OAuth app opts into expiring tokens,
so the tool holds an 8-hour access token plus a refresh token. The tool
renews the access token while it lives: proactively when a run starts
near expiry, and reactively on a 401/403. The refresh token is replaced
when the exchange returns a new one and kept when it does not. The tool
re-runs the device flow when the refresh token dies, and only in a
context that can show it (a terminal or the TUI). A rejected token
mid-operation triggers at most one refresh and one retry per operation,
then a clean error.

The alternative that keeps the user out of token handling was rejected: a
non-expiring device-flow token with a local 180-day rotation policy and
revocation of the old token. It is less machinery, but the token stays valid
at GitHub for its whole life until rotation happens, and rotation is something
we invent instead of something GitHub enforces. The expiring-token path costs
a refresh state machine; in exchange the real exposure window of a leaked
token is eight hours no matter what the tool does.

The fine-grained PAT template URL (a pre-filled token creation page the user
opens and pastes back) was rejected because it makes the user handle the
secret and click through a form, which is exactly the onboarding cost this
decision exists to remove. Hand-written tokens (plain-text file or
`PI_SYNC_TOKEN`) remain supported as the scripted and CI escape hatch, but the
tool never refreshes or rotates a token it did not create.

The device flow needs a registered OAuth app, so the app's public client id
lives in a local config file written by a one-time setup wizard, with an
environment override. The id stays out of the source until the app exists.
