# Preview mail integration configuration

`preview-first-chat-core --render-integrations` renders the bounded configuration
for `capiro-preview-first-chat-core`. It performs no AWS calls, reads no secret
values, and changes no image, service, IAM role, DNS, listener or provider registration.
The output contains ECS `environment` and `secrets` entries plus the additional
`executionRolePolicy` needed to retrieve those referenced secrets.

Use this focused overlay against the freshly inspected serving task. **Do not
deploy the full `--render` stack for this change:** its `d03a118` image pin predates
`integrations_only`, and its other settings do not represent the current service.
The existing full-stack binding remains inert and rejects an `integrations` field.
The runtime at `backend-import` base `00f6d045a0` and deployed source
`746eef718dad9ba57c6c501443d4ebd9cff307e6` supports the explicit API owner and named
`engagement-sync-scheduler` exception. Release must confirm the serving image still
contains that behavior; this infrastructure change does not require an image rebuild.

## References supplied by Release

Prepare a local JSON binding with exactly `secretArns` and `kmsKeyArns`:

```json
{
  "secretArns": {
    "MICROSOFT_CLIENT_ID": "<complete existing app-credential secret ARN>",
    "MICROSOFT_TENANT_ID": "<complete existing app-credential secret ARN>",
    "MICROSOFT_CERT_THUMBPRINT": "<complete existing app-credential secret ARN>",
    "MICROSOFT_CERT_PRIVATE_KEY": "<complete existing app-credential secret ARN>",
    "GOOGLE_CLIENT_ID": "<complete existing app-credential secret ARN>",
    "GOOGLE_CLIENT_SECRET": "<complete existing app-credential secret ARN>",
    "OAUTH_STATE_SECRET": "<complete preview-owned secret ARN>",
    "OAUTH_TOKEN_ENCRYPTION_KEY": "<complete preview-owned secret ARN>"
  },
  "kmsKeyArns": ["<exact customer-managed key ARN used by the referenced secrets>"]
}
```

All eight references must be distinct, complete Secrets Manager ARNs in account
`967807252336`, region `us-east-1`; JSON fields and version suffixes are not accepted.
Provider app credentials may use the existing app registrations after adding the
preview callbacks. The two OAuth protection secrets must have names under
`capiro/preview/` (an initial `/` is also accepted). Provision these two secrets
before activation; their existence is not inferred or checked by this renderer.
Use an independently generated high-entropy state secret and an AES-256 token key
encoded as 64 hexadecimal characters or base64 decoding to exactly 32 bytes.
Retain both secrets and their values across releases. Replacing the token key makes
existing preview grants unreadable; rotating the state secret invalidates in-flight OAuth.
Never reuse the live OAuth state or token-encryption key. Connections copied from
the live database need fresh preview reconnects; the new preview key cannot decrypt
their stored grants. Release must account for those rows before enabling auto-sync.

List each customer-managed KMS key needed by these secrets once. Use `[]` when all
use the AWS-managed Secrets Manager key. The generated decrypt grant is restricted
to Secrets Manager and the listed secret encryption contexts; key policies must
also permit the preview task execution role. No secret values belong in the binding,
rendered artifact, repository or review evidence.

From the repository root (output must not exist):

```sh
pnpm --filter @capiro/infra-cdk exec ts-node --prefer-ts-exts bin/preview-first-chat-core.ts --render-integrations /private/preview-integrations.json /private/preview-integrations-overlay.json
```

Exit `0` means the local artifact was written; exit `2` means invalid arguments,
binding, or output. Rendering does not validate AWS existence or provider registration.

## Authorized release and acceptance

1. Register the exact Microsoft and Google callback URLs below on their app
   registrations, and confirm the dedicated `capiro-preview-services` edge owns
   the API host. Its existing GET `/api/*` and POST Microsoft notifications routes
   already forward to preview Core; no live edge rules need changing.
2. Confirm preview uses its persistent clone and that no other process owns sync
   for the preview connections. Complete the fresh preview grant preparation above.
3. Snapshot the serving task definition and execution-role policy for rollback.
   Add the rendered policy to the **task execution role**, preserving its existing
   grants. Merge the rendered entries into container `core` by name, replacing
   duplicate names and removing any environment entries for keys supplied through
   `secrets` (and conversely). Preserve the current image, `RELEASE_SHA`, task role,
   networking, volume mounts, other environment/secrets and service settings.
   Review that bounded diff before registering or rolling a task revision.
4. With the normal preview release authorization, roll only the preview Core
   service. Verify both capability checks, a fresh Microsoft and Google connect,
   callbacks returning to preview Settings, manual sync and subsequent scheduler
   sync/refresh. Verify Microsoft notification validation and subscription renewal;
   record counts and outcomes without tokens, callback codes or private identifiers.
   Confirm Engagement sends, Recall and generic Engagement workers remain disabled;
   preserve the serving settings of other features. Local rendering and
   synth tests do not establish these provider or deployed results.
5. Roll back to the captured task definition if acceptance fails; retain the new
   preview secrets. Restore only the added execution-role grants after the new tasks
   have stopped. Recheck the serving posture after rollback.

| Setting                                                 | Rendered value                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Microsoft callback                                      | `https://first-chat-preview.app-dev.capiro.ai/api/engagement/integrations/microsoft/callback`      |
| Google callback                                         | `https://first-chat-preview.app-dev.capiro.ai/api/engagement/integrations/google/callback`         |
| Graph notifications                                     | `https://first-chat-preview.app-dev.capiro.ai/api/engagement/integrations/microsoft/notifications` |
| Both success redirects                                  | `https://portfolio-preview.app.capiro.ai/settings/integrations`                                    |
| Runtime                                                 | `api`, `shadow`, `integrations_only`, explicit background owner `api`                              |
| Sync/callbacks                                          | Enabled; existing sync interval of 20 minutes                                                      |
| Recall, Engagement sends and generic Engagement workers | Disabled by the existing runtime policy; other feature settings are preserved                      |
