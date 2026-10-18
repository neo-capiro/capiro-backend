# Directory contact trips extraction

## Source and boundary

This slice starts at local Directory detail commit
`71e9cb82773b9386110f782f9e8eed7339f2cf88`, following the reviewed
PR80 receiving commit `00ebd1ac17332d50a6c6c5843ea2d07c1258c9bf` and
committee-index commit `b6e5bc5235b0bdf3dea20313d9e1f21fd547cedd`.
It moves the LegiStorm trip query and response mapping from
`DirectoryService.getContactTrips` to `directory-contact-trips.ts`.
The public service method, controller route, and `normalizeContactId` validation
remain in place. This reader does not fetch a directory snapshot or validate
contact existence, as the existing global travel read does not require either.

## Consumer and behavior evidence

- `DirectoryController.contactTrips` still serves
  `GET contacts/:contactId/trips` through the same service method. The Web
  `ContactTripsSection` still calls `getContactTrips` for member and staff
  profiles; neither consumer nor its DTO changed.
- Staff IDs still query `travelerStaffId`; member IDs still query both approver
  and traveler member IDs. Non-numeric suffixes still return an empty payload
  without querying. The query keeps the `startDate`/`filedDate` descending
  order and 50-row limit.
- Self-approved trips still choose `traveler`, and staff IDs cannot become
  approvers through a numeric collision. Nullable dates, destination/sponsor
  array fallbacks, and the other-party name mapping are unchanged.
- The trip table remains a global read. No auth, tenant middleware, outreach,
  Meri, Objective/read branch, migration, lockfile, shipping, preview, or cloud
  path changed. No dynamic registration was removed.

## Size and focused checks

Before this slice, `directory.service.ts` was 1,609 lines and 65,586 bytes.
After extraction it is 1,567 lines and 63,804 bytes; the new module is 55
lines and 2,198 bytes. The two source files total 66,002 bytes, 416 more than
the preceding service, while the main service is 42 lines shorter. Relative
to PR80, the service is 680 lines and 27,931 bytes smaller after the three
Directory extractions.

At the starting commit, `directory.service.spec.ts` passed 25/25 tests,
including all eight direct trip cases. After extraction, the service and
controller suites passed 33/33. A focused strict TypeScript check of the
service and new reader passed. Tests used existing local dependencies and a
task-local Jest cache; no install, database, network, AWS, or build action ran.
An independent review checked the moved query and projection against the
parent source and the retained route and contract.
