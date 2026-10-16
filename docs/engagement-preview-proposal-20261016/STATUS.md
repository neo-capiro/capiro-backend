# Inactive Engagement preview source proposal

Base: `016e79b585c14f20d13669e13c987c01e3dd29dd`. PR27, its evidence, frozen shipping backend `cd3c51e`, accepted Team `2758775d` and frontend shipment `9da3616a` remain separate and unchanged.

This branch adds files only under `docs/engagement-preview-proposal-20261016/`. It proposes an exact fixed-operation/Core-method/path filter and a read-only role/ACL preflight. Production files, admission maps, consumers, flags, headers and target bindings are unchanged. All nine Plan operations remain held by the existing frontend read-only preview.

Local checkout initialization has been reconciled after the transport interruption. It is an isolated checkout based on exact `016e79b5`. Small built-in Node checks are permitted alongside Shipping's reserved heavy-test slot; no heavy compiler, browser or native database process is launched here.

The frontend owner and Shipping report no conflicting legacy-map edits. Neither claims ownership of a future active map/call-site change. This proposal does not allocate that work or activate it.

See [README.md](README.md) for the exact boundary and adoption blockers, [FRONTEND-COORDINATION.md](FRONTEND-COORDINATION.md) for source references, and [QUALIFICATION.json](QUALIFICATION.json) for the sealed offline evidence. SQL remains unparsed and unexecuted by PostgreSQL. Current target database posture and runtime binding are unverified; no target action is pending from this lane.
