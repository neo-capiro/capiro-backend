# Planner capacity permissions and row actions

Twenty-first release, live on healthy Strategies 53 / web-vNext 472. Full Asana Work parity remains open. This release uses Strategies-owned project configuration and capacity APIs; it requires no schema migration or additional Capiro integration.

Project admins choose whether allocation changes require project admins, or allow admins and editors. Older projects retain their existing admins-and-editors behavior. Only project admins can change the setting. Every allocation create, date/effort edit, duplicate, archive, restore and transfer checks the current source and destination project setting under the existing tenant advisory lock. Read-only editor views remain visible; plan administration never overrides source permissions. Restricted editors' revision snapshots become stale when editing access changes. Unrelated organization admins gain no private-source access.

Project/people/placeholder rows expose menus for seeded allocation creation and explicit bulk transfer selection. Project rows open the exact project. Transfers preserve all selected opening versions and require the user to choose the destination before saving. Rows over the atomic 100-allocation limit report an error instead of silently truncating. Rows spanning a restricted source cannot select an incomplete transfer. Project choices and cell controls respect the current setting.

Validation: 218 selected API/database checks in twelve suites, 197 distinct web checks in 27 files, the tenant-scope guard and production API build pass. Restricted PostgreSQL tests cover source/destination policy checks, atomic batch rollback, recovery, explicit project admins, unrelated organization admins and revision changes. Synthetic browser QA verifies row transfers with preserved effort/dates, exact project navigation and saved allocation settings. Final web typecheck/production build, exact-source ARM64 cloud builds and authenticated live release qualification pass.

Primary requirement: [Asana capacity planning](https://help.asana.com/s/article/capacity-planning). Rules/bundles cannot currently create allocations; their broader permissions remain in the full parity audit. Remaining capacity profile fields, portfolio aggregation, common/individual capacity menus, costs and precise continuous bars are tracked separately.


## Live qualification and recovery

Deployed source `8d9dcbca57aabbb0c75ac0e2e6f11cf446bd28fa` preserves live web 471's Newsletter and Meri updates. The Planner implementation is identical to feature commit `f5e5d174115cbdc65eaef590f24c16b01067ea30`. Only immutable images and release identifiers changed in task definitions. Both services finished with one completed deployment, one healthy running task and no pending tasks. The Strategies health endpoint passes and runtime-config.js reports the deployed source.

| Service | Revision | Immutable image |
| --- | --- | --- |
| Strategies | 53 | `sha256:0c4bad7709cfb5d2eaa2e7aa86658635ec1c3cd78b59bbb2b6e45d6723cc7cbf` |
| web-vNext | 472 | `sha256:10463571d05d25d319a2bf9548f66f530cde87fe6a2930984b020b764539d548` |

Authenticated QA verifies the admin-only project setting after reload, placeholder-only seeded creation, project-row creation, explicit two-allocation transfer, exact project navigation, saved February view, downloaded CSV with both IDs and 30 total hours, archive/menu recovery and recoverable cleanup. Private test project `299d6104-ab88-4d77-bcef-999df4fb2836`, plan `9118469c-b301-4704-a72e-cf236b97cb6c`, team, placeholder and allocations `b1defad9-2910-4ca1-a790-7d2a8fb5264b` / `d3cfadd4-4da9-4619-aaf0-0aaca9486093` are all archived. Allocation dates remain February 1–12, 2027, with 10/20 hours and final versions 5/3.

Independent read-only proofs run as the actual non-superuser, non-RLS-bypass `capiro_app` role. All 28 migration checksums (12 Planner migrations), 11 forced-RLS tables and six immutable tables pass. Original record hash `13170166ebf66ca5e78cdaf23488e44656318b2b15d59512be4a85ed8d1694ae` is unchanged. Original 152 events, 14 owner time events, the 85-minute week/version 2, preference version 4, inactive timer, zero unread Planner items and eight unrelated bell items remain unchanged. No new tasks, task time events or Inbox rows were created.

Evidence is retained in ignored `artifacts/planner/capacity-permissions-*`: API/web regression/build logs, immutable cloud-build metadata, task/service snapshots, schema and transferred/archived/restored/cleanup proof logs, downloaded CSV and live policy screenshot.

For a frontend rollback, web 471 remains the recorded compatible baseline; retain Strategies 53 to interpret persisted allocation policies. Strategies 52 predates the new field and must not be restored blindly after policy writes. A compatible forward API fix is preferred; no migration rollback is needed.
