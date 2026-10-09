# Meeting prep hearing scope hotfix

Candidate source: ce698b63f22f57b124340241d52a07ba2ffd9185
Worker image: 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api@sha256:9748c950f53a30e27690d211e18cdedc80c1143386281035ac9fa7159679613c
CodeBuild: capiro-build-web-dev:8fef29b8-3032-491c-89f4-38845b93ebae

The production candidate overlays only the hearing reader, regression tests and runbook on deployed worker source 7d2d19bf572b58f5fd17ab5f3f79e85d027b2d93. No migration, credentials, runtime policy or other service changes.

Validation completed:
- 52 focused tests passed across hearing retrieval, meeting context and comprehensive generation.
- Full API TypeScript check passed.
- Native ARM64 Node 22.23.3 image build passed. Packaged offline probe checked prep transcript exclusions, date bounds, quoted evidence, unchanged general retrieval and denied client scope.
- Packaged migrations match candidate source; candidate migrations are byte-identical to the deployed baseline.
- Read-only production replay for the affected C2 client: hearing records fell from 10,000 with more pages remaining to 117 with pagination complete; serialized evidence fell from 10,362,364 to 123,748 characters.

Briefing coverage remains partial and explicitly discloses full transcript and browser-session exclusions. Full hearing transcript readers remain available outside meeting prep.

The successful internal comparison used 30 governed sources and completed in 207,621 ms. The affected client run used 10,717 governed sources. Tenant models also differ; credential settings were not changed by this hotfix.

Production rollout and affected-meeting acceptance are recorded separately after deployment.
