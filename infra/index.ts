import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

// planner-backend on Google Cloud, one stack per environment (dev, prod):
//   - Artifact Registry: the API's Docker images (pushed by CI).
//   - Secret Manager: DATABASE_URL (and the legacy JWT secret, if the project still uses HS256).
//     Pulumi creates the secrets; their values are added by hand (see infra/README.md).
//   - Cloud Run: the API, running as its own service account that can read those secrets.
//
// Skeleton: typechecks, not yet applied (no GCP project yet). Still to add: Workload Identity
// Federation + a deploy service account for GitHub Actions, Cloud Scheduler for the Google
// Calendar worker, a custom domain.

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');
const project = gcpConfig.require('project');
const region = gcpConfig.require('region');
const stack = pulumi.getStack();

/** The Supabase project URL (its JWKS verifies sign-in tokens). Not secret. */
const supabaseUrl = config.require('supabaseUrl');
/** The image tag to run; until CI pushes one, Cloud Run's sample image stands in. */
const imageTag = config.get('imageTag');

const name = (suffix: string) => `planner-${suffix}-${stack}`;

// Turn on the APIs everything below needs.
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

/** The identity the API runs as. */
const runner = new gcp.serviceaccount.Account('api-runner', {
  accountId: name('api'),
  displayName: `planner-backend API (${stack})`,
});

/**
 * Secrets the API reads as env vars. Values are added outside Pulumi, and each needs a version
 * before Cloud Run can start. The legacy JWT secret is only for projects still signing with HS256.
 */
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

// Public: the API checks Supabase tokens itself.
new gcp.cloudrunv2.ServiceIamMember('api-public', {
  name: service.name,
  location: region,
  role: 'roles/run.invoker',
  member: 'allUsers',
});

export const apiUrl = service.uri;
export const imageRepository = imageBase;
export const runnerServiceAccount = runner.email;
