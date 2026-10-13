/** Public resource metadata only. Secret values and ambient configuration are refused. */
export interface PreviewBindings {
  vpcId: string;
  clusterArn: string;
  listenerArn: string;
  albSecurityGroupId: string;
  publicSubnetIds: [string, string];
  availabilityZones: [string, string];
  frontendTargetGroupArn: string;
  clerkIssuer: string;
  clerkApplicationId: string;
  clerkSecretArn: string;
  clerkKeyArn: string;
  clerkPublishableKeyArn: string;
  vpcCidr: '10.90.0.0/16';
  neoTenantId: string;
  automationTenantId: string;
  neoActorId: string;
  automationActorId: string;
  images: Record<'core' | 'workspace' | 'intelligence', { uri: string; sourceHead: string }>;
}

const account = '967807252336';
const region = 'us-east-1';
const keys = [
  'vpcId',
  'clusterArn',
  'listenerArn',
  'albSecurityGroupId',
  'publicSubnetIds',
  'availabilityZones',
  'frontendTargetGroupArn',
  'clerkIssuer',
  'clerkApplicationId',
  'clerkSecretArn',
  'clerkKeyArn',
  'clerkPublishableKeyArn',
  'vpcCidr',
  'neoTenantId',
  'automationTenantId',
  'neoActorId',
  'automationActorId',
  'images',
];
function closed(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...expected].sort().join('|')
  ) {
    throw new Error('Closed preview metadata record required');
  }
}
function text(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !pattern.test(value)
  ) {
    throw new Error('Invalid preview resource binding');
  }
  return value;
}
function pair(value: unknown, pattern: RegExp): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || value[0] === value[1]) {
    throw new Error('Two distinct preview topology bindings required');
  }
  return [text(value[0], pattern), text(value[1], pattern)];
}
export function previewBindings(input: unknown): PreviewBindings {
  closed(input, keys);
  const arn = (service: string) => `arn:aws:${service}:${region}:${account}:`;
  const secret = (name: string) =>
    new RegExp(`^${arn('secretsmanager')}secret:/capiro/preview/${name}-[A-Za-z0-9]{6}$`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  closed(input.images, ['core', 'workspace', 'intelligence']);
  const images = {} as PreviewBindings['images'];
  for (const name of ['core', 'workspace', 'intelligence'] as const) {
    const image = input.images[name];
    closed(image, ['uri', 'sourceHead']);
    images[name] = {
      uri: text(
        image.uri,
        new RegExp(
          `^${account}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/capiro/preview-${name}@sha256:[0-9a-f]{64}$`,
        ),
      ),
      sourceHead: text(image.sourceHead, /^e50aed3c5b5cce58317b37de442482fa970842cb$/),
    };
  }
  const result: PreviewBindings = {
    vpcId: text(input.vpcId, /^vpc-[0-9a-f]{17}$/),
    clusterArn: text(
      input.clusterArn,
      new RegExp(`^${arn('ecs')}cluster/capiro-portfolio-preview$`),
    ),
    listenerArn: text(
      input.listenerArn,
      new RegExp(
        `^${arn('elasticloadbalancing')}listener/app/[A-Za-z0-9-]{1,32}/[0-9a-f]{16}/[0-9a-f]{16}$`,
      ),
    ),
    albSecurityGroupId: text(input.albSecurityGroupId, /^sg-[0-9a-f]{17}$/),
    publicSubnetIds: pair(input.publicSubnetIds, /^subnet-[0-9a-f]{17}$/),
    availabilityZones: pair(input.availabilityZones, /^us-east-1[a-f]$/),
    frontendTargetGroupArn: text(
      input.frontendTargetGroupArn,
      new RegExp(`^${arn('elasticloadbalancing')}targetgroup/[A-Za-z0-9-]{1,32}/[0-9a-f]{16}$`),
    ),
    clerkIssuer: text(input.clerkIssuer, /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/),
    clerkApplicationId: text(input.clerkApplicationId, /^app_[A-Za-z0-9]{8,80}$/),
    clerkSecretArn: text(input.clerkSecretArn, secret('clerk/secret-key')),
    clerkKeyArn: text(input.clerkKeyArn, new RegExp(`^${arn('kms')}key/[0-9a-f-]{36}$`)),
    clerkPublishableKeyArn: text(input.clerkPublishableKeyArn, secret('clerk/publishable-key')),
    vpcCidr: text(input.vpcCidr, /^10[.]90[.]0[.]0\/16$/) as '10.90.0.0/16',
    neoTenantId: text(input.neoTenantId, uuid),
    automationTenantId: text(input.automationTenantId, uuid),
    neoActorId: text(input.neoActorId, uuid),
    automationActorId: text(input.automationActorId, uuid),
    images,
  };
  if (
    result.neoTenantId === result.automationTenantId ||
    result.neoActorId === result.automationActorId
  ) {
    throw new Error('Neo and automation require distinct preview tenants and actors');
  }
  if (/capiro-(prod|dev)-alb/i.test(result.listenerArn)) throw new Error('Source ALB refused');
  return result;
}
