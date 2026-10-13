# Required preview resources and bounded cost proposal

The plan reuses the existing preview VPC, public subnets, ECS cluster, ALB443 listener, frontend target, hostname and certificate. It proposes **no new ALB, NAT gateway, public hostname, certificate, queue or worker**. Meri Greenfield retains its separately approved infrastructure; its costs are outside this three-service proposal. No real resource inventory or bill was retrieved in this lane.

| Proposed stack | New source resources |
| --- | --- |
| Capiro-Portfolio-Preview-Backend-Network | Two isolated DB subnets10.90.11.0/24 and10.90.12.0/24; one empty route table and two associations; separate backend/database groups and explicit ALB/backend/database rules |
| Capiro-Portfolio-Preview-Data | Aurora PostgreSQL16.8 cluster and two Serverlessv2 instances, each0.5–1ACU; DB subnet/parameter groups; new KMS key/alias; four generated master/app/promoter/analytics secret definitions; attachment; log-retention support Lambda/role/policy |
| Capiro-Portfolio-Preview-Assets | New encrypted `capiro-preview-tenant-assets-967807252336` bucket, policy, key/alias and canonical strategy access role/policy |
| Capiro-Portfolio-Preview-Backends | Three held ECS services/tasks, six task/execution roles, five inline policy resources, three log groups, three IP target groups, five listener rules |

Test Clerk application, matching secret/publishable-key references and their encryption key are mandatory external preview inputs, not supplied production values or provisioned by this proposal. Immutable `capiro/preview-{core,workspace,intelligence}@sha256:…` images are missing. Database app-role/schema bootstrap is not implemented by generating a secret; approved bootstrap/migrations are required. Bucket-wide Core/Workspace grants, public task egress for Clerk/image/log access and source network rules are proposed only and held for review. No S3 upload/provider/network action occurred.

The [null binding record](REQUIRED-BINDINGS.json) lists exact required fields. Verify the actual VPC owns10.90.0.0/16 and both supplied public subnets; the proposed isolated subnet CIDRs are unused; two AZs match; cluster, listener, ALB group and frontend target share that preview VPC/account; listener priorities608–612 are free; and the certificate covers the existing preview host. Regex validation cannot establish any of those facts. Known source certificate reference is `arn:aws:acm:us-east-1:967807252336:certificate/edcc6113-12f5-4154-bfdf-64c7da1037cd`; issued/live attachment has not been freshly verified here.

## Fourteen-day proposal

Propose **$150 incremental budget for14 days**, subject to owner approval and usage monitoring. This is a budget proposal, **not an enforced cloud bill cap**. Zero desired tasks avoids service compute until activation; a provisioned DB would still incur its minimum compute even with tasks stopped. No resource was created and no spend incurred by this source slice.

| Modeled item,336h | Estimate |
| --- | ---: |
| Three Linux/x86 Fargate tasks, each0.5vCPU/1GiB, all active | $24.88 |
| Two Aurora instances, each minimum0.5ACU | $40.32 |
| Two Aurora instances, each maximum1ACU | $80.64 |
| Combined task + maximum DB modeled compute | $105.52 |
| Remaining allowance to$150 | $44.48 |

The Fargate calculation uses the [official us-east-1 example](https://aws.amazon.com/fargate/pricing/): $0.000011244 per vCPU-second and $0.000001235 per GB-second. The Aurora calculation uses the [official Standard example](https://aws.amazon.com/rds/aurora/pricing/) of $0.12 per ACU-hour. These are pricing-page estimates, not a retrieved account quote. Storage, I/O, backups beyond included allowance, Secrets Manager/KMS, log-retention Lambda, ECR/builds, public IPv4, transfer and incremental ALB usage consume the remaining allowance; actual usage can exceed it. Existing shared preview infrastructure's fixed spend is excluded. No paid models/provider activity is admitted.

Performance Insights is off for preview: [AWS capacity guidance](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.setting-capacity.html) recommends2ACU minimum for that feature, outside this bound. Existing dev/staging/prod settings retain their previous branches. Preview logs retain14 days and backups7 days. DB/bucket deletion protection/retention preserve Neo's manual work. At14 days, an owner must review exact resource IDs and usage to renew, stop or approve cleanup; this plan never schedules an automatic data wipe. Greenfield Temporal/model/runtime storage and frontend compute require separate explicit budget admission.
