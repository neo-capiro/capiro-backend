# Directory LegiStorm unused surfaces

This slice starts at local Directory cleanup commit
`799dc59e9c9380ec7b5d0b5fdc1f6a82aea22efd` (the source tree published in
draft PR91). It removes two unused runtime helpers and their tests:

- `LegiStormClient.fetchCongressDistrictsByZip` had no caller outside its own
  spec. The three production `LegiStormClient` constructors are the Directory,
  district, and trips sync scripts. The district script's typed
  `LegiStormDistrictSource` and fetch loop use only `fetchCongressDistrictList`
  and `fetchDistrictKml`. The package/entrypoint dispatcher runs the script;
  the client is not a Nest provider or dynamically registered route or job.
- `retainVendorRecord` returned its argument unchanged. Only its own spec
  called it. The unknown-field and money-string assertion now checks the
  actual `fetchMembers` result, alongside the existing raw-page assertion.

The shared district record type retains the documented `/congress/zipcode`
wire-shape evidence. The list and KML methods, ingestion commands, schemas,
migrations, archives, and production DTOs are unchanged. Removed source and
tests remain recoverable from the parent Git commit.

The two runtime files shrink from 23,979 to 23,075 bytes (904 fewer); the
three affected specs shrink from 27,928 to 26,893 bytes (1,035 fewer). The
five code/spec files together shrink by 1,939 bytes. Before editing, the three
LegiStorm suites passed 40/40 tests; after editing, they passed 38/38, and
including the directly consuming district sync suite passed 56/56. A focused
strict TypeScript check of the client, types, and sync script passed. No build,
install, database, AWS, or deployment action ran.
