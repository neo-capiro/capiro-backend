# Outreach V3 Target Profile Contract V1

## Goal

Provide enough current, source-aware target information for selection and later governed personalization without exposing unrestricted relationship, note, transcript or email content.

## Profile sections

### Identity

- display name
- target source/type
- client association where authorized

### Role

- title
- organization/office
- `current | historical | unknown`

### Contact

- normalized email
- phone when available
- `available | missing | invalid`

### Jurisdiction

- government level
- chamber
- state/district
- committees
- issue areas

### Relationship metadata

- last interaction date when available
- whether governed notes exist
- relationship owner label when available

This phase does not return relationship note bodies.

### Personalization facts

Every fact includes:

- code and label
- value
- verification state
- `usableForPersonalization`

User-supplied notes and unknown/historical roles are not automatically usable for personalization.

## Warnings

- `ROLE_HISTORICAL`
- `ROLE_UNKNOWN`
- `EMAIL_MISSING`
- `PROFILE_LIMITED`

## Restricted categories

The response explicitly states that the following are not included:

- unscoped relationship note bodies
- private meeting-note bodies
- private email bodies
- sensitive biographical attributes

## Snapshot comparison

When opened inside a session, the API compares the current target profile to the selected Campaign Spec snapshot and returns:

- current snapshot
- changed snapshot plus safe changed-field names
- unavailable source
- unselected profile

It never rewrites Campaign Spec as a side effect of reading a profile.

## Authorization and nonleakage

- session ownership is checked first;
- each target is re-resolved;
- client scope is reauthorized;
- inaccessible, ethical-wall and missing targets return the same safe not-found behavior;
- no raw provider/database error is returned.
