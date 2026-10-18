# Retained document receiver source gate

This additive source branch starts from Core PR92
`7f72239d4f7746ea99fe10df701190132af84e87`. It receives the exact Meri PR162
contract at `dee9ac55546d9a59dc6bba79cd4fc2cbba869000`, stacked on PR161.
No new pull request, deployment, live configuration or paid call is part of
this change.

## Immutable Meri selection and economics

The operation stays `read_client_documents@0.2.0`, with document schema
SHA-256 `71dd53119af2c0226372916e3645765687e8653da2f48b60d55c1a7a75c05247`
and semantic validator source SHA-256
`a545d51cda2e8d430ebb66f739524f55fc243ac87a923ea96dc140bab50c10e9`.
The signed `{input,metadata:null}` request and four-field correlation do not
carry pricing, runtime identity or an extraction-mode selector.

Only the original admitted general-read manifest with
`profile:'meri.general_reads'`, `contractVersion:'0.2.0'` and
`profileVersion:'1.1.0'` supplies the new text-only variant:

```json
{"mode":"source_text_only","route":"/api/clio/tools/read_client_documents","coreSourceCommit":"<Git SHA40>","coreImageDigest":"sha256:<64 lowercase hex>","configurationSha256":"<64 lowercase hex>"}
```

The fixed local-read charge is **1 microusd**, as defined by Meri's
`documentReadCharge`; Core also verifies the allocation's actual document
schedule entry charges exactly 1. The unconditional tariff remains null.
The old complete paid pricing manifest does not qualify this Core source path.

## Original allocation and current runtime are separate

`readRunFacts` projects the exact document tariff from
`readMeriAdmittedRun().allocation`, after the existing canonical budget lock,
original ADMITTED binding/grant-set checks and allocation hash checks. It
verifies the manifest hash, required manifest identity, matching budgets,
the exact selected operation, the closed pricing variant and the schedule.
An absent or incompatible document variant yields no document qualification;
it does not change admission for other read families.

The fresh frozen projection travels only through the request-local
`MeriReadDelegationGrant` into document admission. It is not a token claim,
body field, metadata field, header, normalization-context field or environment
value. Final delegation release reconstructs it under the same existing lock
and refuses any change. No new issuer, grant, security permission or SQL object
is introduced.

The document receiver now calls the existing provider-disabled owner only when
that original tariff matches a separate current runtime identity. The optional
`RetainedDocumentRuntimeIdentityReader.readCurrent()` seam must obtain
independent current `{sourceHead,imageDigest,configurationSha256}` evidence.
It is called separately before and after the source read. All three values must
match the original allocation; missing, malformed, unavailable or changed
evidence withholds the result. The actual extraction owner unconditionally
uses `allowPaidExtraction:false` for every retained document token. There is
no paid/legacy fallback, request mode or unsigned switch.

## Runtime remains unavailable

**A fail-closed runtime identity adapter exists, but its independent trusted
readback port and Nest provider are not implemented or registered.**
The default source path therefore still returns
`MERI_RETAINED_SOURCE_UNAVAILABLE` (503) before reading attachment metadata or
bytes. Environment digest equality, RELEASE_SHA/GIT_SHA, release headers or
OCI labels alone cannot open this gate. PR90's `FIRST_CHAT_CORE_IMAGE_PINS`
remains null; no integrated current Core image or effective-configuration
measurement is asserted here.

The deployment/render owner must qualify an integrated Core source commit,
digest-addressed ECR image and current ECS task/container readback, define the
effective-configuration hashing procedure, and implement/register the trusted
control-plane readback provider for the
[source adapter](CORE-DOCUMENT-RUNTIME-IDENTITY-READER-20261018.md). Meri's
shipping owner must compare those same measured pins
before issuing its 1.1.0 allocation. The real signed task credential relay,
keys/facts setup, listener/deployment and live readback remain separate gates.

Audio/video fails closed before Whisper; blank PDF text layers return their
existing truthful missing-content/blocked-continuation DTO without vision.
Meri currently maps this family's unavailable failure to INVALID_RESULT, so
audio failure is not claimed as a completed user-facing unsupported-result
contract. Full paid extraction still requires complete measured pricing,
resolved-model/output/input bounds and a reliable pre-call audio-duration cap.

Verification passed **7 focused suites, 112 tests**, the narrow pure-module
TypeScript check and `git diff --check`. Focused tests cover the actual serialized allocation structure, invalid
variants and charges, immutable request-local propagation, original-grant
rollback, allocation drift at release, missing runtime reader, each current
runtime pin before/after the read, and no legacy/provider fallback. No broad
API build or live AWS/SQL/provider call is required or asserted.
