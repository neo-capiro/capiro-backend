# C2 Krisp production acceptance

The C2 Strategies Krisp path is live. For a matched meeting, Krisp's finished
notes are stored as the approved Meeting Note. Meri generates a separate
Debrief from those notes. Other tenants retain their existing transcript-based
Meeting Note and Debrief generation.

The guarded release operator promoted the following pinned task definitions.
All three ECS services were `ACTIVE`, at their desired running count, with no
pending tasks on 2026-10-09:

| Service | Task definition | Running / desired |
| --- | --- | --- |
| API | `capiro-dev-api:650` | 2 / 2 |
| Engagement worker | `capiro-dev-engagement-api:155` | 2 / 2 |
| Web vNext | `capiro-dev-web-vnext:478` | 1 / 1 |

The one connected C2 Krisp user's previously documented enabled preference
was restored through the application service after the connected personal MCP
server and active membership were verified. A subsequent worker sync completed
without a recorded error. The four imports without a reliable meeting match
remain `needs_match` so no notes are attached to a guessed meeting.

An authenticated service readback under the import owner's tenant context
returned both artifacts for a converted meeting. Both were visible and
`approved`; the Meeting Note was nonempty and the Debrief was nonempty,
separate, and in Meri's generated recap format. This exercises the same
`listMeetingNotes` and `listMeetingDebriefs` methods used by the Meeting tab
without logging their private bodies.

Historical conversion reads stored Krisp Meeting Notes, leaves them unchanged,
and calls Meri's native debrief generator. It skips debriefs that have been
edited or shared and rechecks tenant, membership, meeting ownership, import
mapping, client assignment, and unchanged source/artifact state before an
update. Four idempotent one-off ECS shards perform the conversion. They run
from the qualified API image but do not change the API service entrypoint.

The conversion task IDs are `55053eb3b5a448bf8edf535c552c4a80`,
`6210589956cc4f0da6c1b8d36b92b42f`,
`62184dadf1634641b38c4e0774c4a8ab`, and
`66904b70cce14fe385ce088ec6cc9dcb`. A separate operator readback task,
`80bed479b0d5472dafdae7ac034caaa2`, exited 0 with both approved artifacts
visible. The read-only aggregate count task was
`a498894035c24c58a47232547602eb0d` and exited 0.

After the first pass, the post-run aggregate count found 48 legacy copied
debriefs still eligible. The retry acquired row locks on each source note and
debrief, rechecked the artifact pair under those locks, and then updated the
debrief. Its four task IDs were `dade955a79204f2eaf14407331beb04b`,
`b6a123a06c6241308a1d41c20e602c38`,
`028d787efaa2465a9bc1e1291818ac6b`, and
`07c37c9b14d04153bd2edee175a96436`. The retry logged aggregate skip
reasons without exposing private meeting contents.

All four first-pass and all four retry tasks exited 0. The retry converted
exactly 48 remaining debriefs (6, 18, 11, and 13 by shard) with zero failures,
missing records, or recheck rejections. The final read-only production count
task `a7c98f89b77e43169ba15ee0ba80abec` exited 0 and reported:

| Check | Result |
| --- | ---: |
| Completed, matched C2 Krisp imports | 393 |
| Legacy debrief copies still matching their Krisp Meeting Note | 0 |
| Nonempty, distinct Debriefs | 393 |
| Debriefs in Meri's generated recap format | 392 |
| Missing Meeting Notes or Debriefs | 0 |
| Imports still awaiting a reliable meeting match | 4 |

One pre-existing Debrief already differed from its paired Krisp note before
the conversion and was left intact; it accounts for the one distinct Debrief
outside Meri's generated recap format. The final zero-work dry run
`f56d2d1fa22844ec9c826e73a4bf2cc4` scanned all 393 completed imports and
found zero eligible legacy copies. A fresh owner-facing service readback
`251b181d58c74f9d9e422d82311f9a59` returned both approved artifacts with
separate nonempty bodies. Both tasks exited 0.

The connected C2 user's preference remained enabled, its worker check-in
advanced to `2026-10-09T16:39:52.963Z`, and it had no sync error. The four
`needs_match` imports remain unassigned to avoid associating a Krisp note with
the wrong meeting.
