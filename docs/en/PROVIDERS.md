# Model providers

[简体中文](../PROVIDERS.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Provider settings determine where this instance sends model tasks. All signed-in users share the active provider. The upstream must support the Responses API, streaming and Codex tool calls; a Chat Completions endpoint or a working model catalog alone does not establish task compatibility.

## Add and verify a provider

Open Settings → Providers, save a profile, then retrieve models or activate it.

| Field            | Value                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Name             | A display label, 1–80 characters                                                                           |
| Base URL         | For example `https://provider.example.com/v1`; omit the final `/responses` or `/chat/completions` endpoint |
| API key          | Required for new profiles; leave the edit form blank to retain the saved key                               |
| Default model    | The exact upstream model ID; leave empty to use the executor default                                       |
| Available models | One ID per line, entered manually or replaced by Fetch models                                              |

The instance accepts up to 20 profiles and 100 available models per profile. Model IDs are limited to 200 characters and cannot contain whitespace. Base URLs cannot contain embedded credentials, query parameters or fragments. HTTPS is required except for HTTP on `localhost`, `127.0.0.1` or `[::1]`.

Saving does not test upstream authentication. Verify in stages: save → fetch models → activate while idle → send a simple message in a test project → exercise tool calls. Catalog access, model permissions and tool support are separate checks.

## Fetch models: a persistent, manually refreshed catalog

Fetch models on a saved profile makes a backend request. Success replaces that provider's available-model list and stores it with a fetch timestamp in SQLite. Reloading the page, restarting the service or switching providers does not refresh the catalog automatically.

| Endpoint                                           | Caller and purpose                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Workbench `POST /api/providers/:id/models/refresh` | The button; fetches upstream and updates the database                       |
| Workbench `GET /api/models`                        | The chat UI; uses the stored catalog and default model for custom providers |
| Upstream `GET …/models`                            | The backend; sends the provider's saved key                                 |

The upstream URL is derived from the base URL:

| Base URL                                  | Fetch URL                                        |
| ----------------------------------------- | ------------------------------------------------ |
| `https://provider.example.com`            | `https://provider.example.com/v1/models`         |
| `https://provider.example.com/v1`         | `https://provider.example.com/v1/models`         |
| `https://provider.example.com/gateway/v1` | `https://provider.example.com/gateway/v1/models` |

Expected upstream response:

```json
{ "data": [{ "id": "model-a" }, { "id": "model-b" }] }
```

Requests have a 15-second timeout and a 1 MiB response limit, accepting at most 100 unique valid IDs. Redirects are refused; incomplete pages declaring `has_more: true` are not saved. Invalid responses, timeouts, oversized catalogs and network failures preserve both the previous list and timestamp. There is no automatic retry.

A valid empty list clears available models while retaining the separate default model. Fetching does not switch providers, restart the executor or change the selected model. An event updates the active provider's chat menu. Manual editing remains available; the next successful fetch replaces that list. The timestamp records the last successful fetch, not the absence of later manual edits.

Concurrent fetches for one provider are rejected. If its URL, key or list changes during the request, or the provider is deleted, the result cannot overwrite the newer configuration; fetch again manually. Server default configuration uses CLI model discovery, outside these custom-provider cache rules.

## Activation and model selection

Wait until tasks, approvals and queues are idle before switching. The backend restarts its own App Server and passes credentials through the child-process environment without modifying shared CLI authentication files. Selecting Server default configuration restores the service account's CLI configuration.

Activation affects the whole instance. Continuing an existing conversation may send its earlier context to the new upstream. Executor startup failures trigger a rollback attempt; model request failures do not automatically switch routes or resend tasks. Successful activation establishes executor configuration only.

The composer model applies to the next turn; historical turns display their recorded model. Steering retains the running turn's model. Personal model filters affect menu visibility, not server authorization. A catalog of IDs does not establish reasoning-effort support.

## Proxy, balance and troubleshooting

Configure outbound proxies in the instance's `.env` or service environment, then restart the backend. Keep the provider URL as the upstream address. See [Configuration](CONFIGURATION.md) and [Operations](OPERATIONS.md) for precedence and network checks.

Balance queries use the provider's `/v1/usage` convention, which many Responses-compatible services do not implement. An unavailable balance does not establish that model calls are unavailable.

| Symptom                           | Check first                                                             |
| --------------------------------- | ----------------------------------------------------------------------- |
| Upstream reports 401/403          | Key validity and catalog access permissions                             |
| Upstream reports 404              | Base path and upstream catalog endpoint; use a manual list if necessary |
| Timeout or connection failure     | Service proxy, DNS, certificates and upstream connectivity              |
| Fetch returns 409                 | Fetch/switch in progress or configuration changed during the request    |
| Model listed but task fails       | Exact ID, quota, Responses, streaming and tool support                  |
| Active provider cannot be deleted | Activate another profile or the server default first                    |

## Credentials and backups

APIs do not return saved keys. Profiles are stored in SQLite; keys use AES-256-GCM with encryption material in `DATA_DIR/providers.key`. Back up the database and key file together. The database alone cannot recover keys after that file is lost. Signed-in users share management access; encryption does not replace service-account and filesystem permissions.
