import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');
const project = gcpConfig.require('project');
const region = gcpConfig.require('region');
const stack = pulumi.getStack();

const supabaseUrl = config.require('supabaseUrl');
const imageTag = config.get('imageTag');

const name = (suffix: string) => `planner-${suffix}-${stack}`;

const apis = ['run', 'artifactregistry', 'secretmanager', 'iam'].map(
  (api) =>
    new gcp.projects.Service(`api-${api}`, {
      service: `${api}.googleapis.com`,
      disableOnDestroy: false,
    }),
);

const registry = new gcp.artifactregistry.Repository(
  'registry',
  {
    repositoryId: 'planner',
    location: region,
    format: 'DOCKER',
    description: 'planner-backend images',
    cleanupPolicies: [
      {
        id: 'keep-recent',
        action: 'KEEP',
        mostRecentVersions: { keepCount: 20 },
      },
      {
        id: 'delete-old',
        action: 'DELETE',
        condition: { olderThan: `${30 * 24 * 3600}s` },
      },
    ],
  },
  { dependsOn: apis },
);

const imageBase = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${registry.repositoryId}/api`;
const image = imageTag
  ? pulumi.interpolate`${imageBase}:${imageTag}`
  : pulumi.output('us-docker.pkg.dev/cloudrun/container/hello');

const runner = new gcp.serviceaccount.Account('api-runner', {
  accountId: name('api'),
  displayName: `planner-backend API (${stack})`,
});

const secretEnv: Record<string, string> = {
  DATABASE_URL: 'database-url',
  ...(config.getBoolean('legacyJwtSecret') && { SUPABASE_JWT_SECRET: 'supabase-jwt-secret' }),
};

const secrets = Object.fromEntries(
  Object.entries(secretEnv).map(([envName, id]) => {
    const secret = new gcp.secretmanager.Secret(
      `secret-${id}`,
      { secretId: `planner-${id}`, replication: { auto: {} } },
      { dependsOn: apis },
    );
    new gcp.secretmanager.SecretIamMember(`secret-${id}-runner`, {
      secretId: secret.id,
      role: 'roles/secretmanager.secretAccessor',
      member: pulumi.interpolate`serviceAccount:${runner.email}`,
    });
    return [envName, secret];
  }),
);

const service = new gcp.cloudrunv2.Service(
  'api',
  {
    name: name('api'),
    location: region,
    ingress: 'INGRESS_TRAFFIC_ALL',
    deletionProtection: stack === 'prod',
    template: {
      serviceAccount: runner.email,
      scaling: { minInstanceCount: 0, maxInstanceCount: stack === 'prod' ? 10 : 2 },
      containers: [
        {
          image,
          ports: { containerPort: 8080 },
          resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true },
          startupProbe: { httpGet: { path: '/health' } },
          envs: [
            { name: 'SUPABASE_URL', value: supabaseUrl },
            ...Object.entries(secrets).map(([envName, secret]) => ({
              name: envName,
              valueSource: { secretKeyRef: { secret: secret.secretId, version: 'latest' } },
            })),
          ],
        },
      ],
    },
  },
  { dependsOn: apis },
);

new gcp.cloudrunv2.ServiceIamMember('api-public', {
  name: service.name,
  location: region,
  role: 'roles/run.invoker',
  member: 'allUsers',
});

export const apiUrl = service.uri;
export const imageRepository = imageBase;
export const runnerServiceAccount = runner.email;
