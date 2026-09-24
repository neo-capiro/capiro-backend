# Stage 3a Jev task registry

The Jev task registry is the source of truth for every task token accepted by
`MERI_JEV_TASKS`. Each record pins the task and question version, answer
primitive, model version, thresholds, failure fallback, rollout capability,
and calibration basis. Cascade tasks also record their confidence and audit
sampling policy. Registry version `jev-task-registry.v3` is emitted with task
versions in canary and passage-selection telemetry.

## Adding a task

Add the token to `JEV_TASKS` and one complete `JEV_TASK_REGISTRY` entry in the
same change. Give it a dedicated rollout control before it can affect output,
state the honest calibration basis, and add focused coverage for validation,
fallback, and telemetry. A registry entry alone does not enable a provider or
make a provisional task live.

## Changing a question, model, or threshold

Treat these as one calibrated unit. Re-evaluate the task against representative
fixtures before promotion, update the question/model/threshold fields in code,
and bump `JEV_TASK_REGISTRY_VERSION`. Do not move `MERI_JEV_MODEL` first: the
pinned model identifies the model for which the recorded thresholds were set.
Question and model versions must remain explicit, never moving aliases.

## Mismatch behavior

An enabled task whose configured model differs from its registry model emits
`meri.jev.registry_mismatch` once per process and cannot apply the old
thresholds. Passage relevance returns its unfiltered evidence fallback with
reason `registry_model_mismatch`. Claim support treats Jev as unavailable for
live use and falls back to the legacy judge. Shadow evaluation may still
observe the candidate model, but cannot change the released turn.

## Traceability

`meri.canary.turn` includes `registryVersion` and a `jevTasks` map for tasks
used by the enrolled turn; each map value has `questionVersion` and
`modelVersion`. These fields are optional when reading older canary events.
`meri.passage_selection` includes the same registry version plus its task's
question and pinned model versions, alongside the provider-returned model.
