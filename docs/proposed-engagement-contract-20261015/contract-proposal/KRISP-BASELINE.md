# Krisp preview-gate baseline classification

**Inherited backend baseline drift; not introduced by frontend Team commit `2758775ddf0e3b17898370be61540498344a9f57`.** No gate input, generated artifact, network rule or route permission was changed.

The untouched backend `cd3c51e940f14e1b2a1040b0ffa445e85d68b332` reproduces `node scripts/engagement-phase3-preview-route-patterns.mjs --check` -> `ENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (5)`, exit 1.

| Method | Exact unaccounted path                           | Current source                                                                                                                                                              |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /api/clio/krisp-notetaker                        | [controller:23](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/krisp/krisp-notetaker.controller.ts#L23) |
| GET    | /api/clio/krisp-notetaker/folders                | [controller:28](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/krisp/krisp-notetaker.controller.ts#L28) |
| GET    | /api/clio/krisp-notetaker/imports/:id/candidates | [controller:38](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/krisp/krisp-notetaker.controller.ts#L38) |
| POST   | /api/clio/krisp-notetaker/imports/:id/match      | [controller:43](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/krisp/krisp-notetaker.controller.ts#L43) |
| POST   | /api/clio/krisp-notetaker/preferences            | [controller:33](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/krisp/krisp-notetaker.controller.ts#L33) |

The controller declares clio/krisp-notetaker with standard_user/RolesGuard and is [registered by EngagementModule](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/engagement.module.ts#L109). All five paths are already in the [frozen primary manifest](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json#L6).

## Exact provenance and offline replay

- [fbf5a1551582f0abc0d6285e3aefefdb209eca5d](https://github.com/neo-capiro/capiro-backend/commit/fbf5a1551582f0abc0d6285e3aefefdb209eca5d), 2026-10-05: added Krisp controller and module registration.
- [62fcce70e16ec121e370a0add1b2e387df225940](https://github.com/neo-capiro/capiro-backend/commit/62fcce70e16ec121e370a0add1b2e387df225940), 2026-10-05: added Krisp to [route inventory generation](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/scripts/engagement-phase0-route-manifest.ts#L27) and committed the five manifest entries.
- The preview generator permits /api/engagement/ and explicitly excludes only internal credential resolve and Recall webhook. Krisp satisfies neither. [Gate policy:59–106](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/scripts/engagement-phase3-preview-route-patterns.mjs#L59). Unaccounted routes fail before generated-file comparison. [Gate failure:169–186](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/scripts/engagement-phase3-preview-route-patterns.mjs#L169).

Read-only replay used the real exported buildPatterns with historical manifests from git show:

| Backend source revision | Primary route count | Unaccounted paths     |
| ----------------------- | ------------------: | --------------------- |
| 62fcce70^               |                 129 | 0                     |
| 62fcce70                |                 134 | Same five Krisp paths |
| Frozen cd3c51e94        |                 135 | Same five Krisp paths |

Preview generator Git blob is identical at all three revisions: `1fda08859597cb5fd0b56d4b4191e4e78115a3ce`.

[Frontend Team commit2758775](https://github.com/neo-capiro/capiro-frontend/commit/2758775ddf0e3b17898370be61540498344a9f57) has exactly seven Team/test/documentation files. It changes no backend controller, manifest, generator or exclusion.

## Required disposition

Record as an inherited failing backend/Krisp check. Its owner must decide correct service/preview coverage independently of this patch. Do not expand the preview/network allowlist, add exclusions merely to hide the failure, regenerate a frozen artifact or treat the separate 25 passing offline tests as a pass for this gate.

No source/artifact mutation, AWS, provider or live database call occurred. Backend status remains clean.
