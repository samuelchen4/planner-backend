import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');
const project = gcpConfig.require('project');
const region = gcpConfig.require('region');
const stack = pulumi.getStack();

const supabaseUrl = config.require('supabaseUrl');
const imageTag = config.get('imageTag');
// Pinned secret versions per secret id (a new value needs a deploy to take effect). The older
// single `secretVersion` setting still pins database-url.
const secretVersions: Record<string, string> = {
  'database-url': config.get('secretVersion') ?? 'latest',
  ...config.getObject<Record<string, string>>('secretVersions'),
};
const corsOrigins = config.get('corsOrigins') ?? 'http://localhost:5173';

// Calendar sync (src/calendars). Two steps so Cloud Run never points at an empty secret:
// `pulumi up` creates the secrets, you add their values, then set `calendars: true` and `pulumi up`.
const calendarsOn = config.getBoolean('calendars') ?? false;
const googleClientId = config.get('googleClientId');
const calendarPublicUrl = config.get('calendarPublicUrl');

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
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  // Must stay the same key forever per environment: it decrypts every stored calendar login.
  CALENDAR_CREDENTIALS_KEY: 'calendar-credentials-key',
};
const calendarSecrets = new Set(['GOOGLE_CLIENT_SECRET', 'CALENDAR_CREDENTIALS_KEY']);

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
          // Calendar jobs run in-process after the response until Cloud Tasks exists (plan step
          // 6), so the CPU must stay on between requests (instance-based billing; still scales
          // to zero when idle).
          resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: !calendarsOn },
          startupProbe: { httpGet: { path: '/health' } },
          envs: [
            { name: 'SUPABASE_URL', value: supabaseUrl },
            { name: 'CORS_ORIGINS', value: corsOrigins },
            ...(calendarsOn
              ? [
                  { name: 'GOOGLE_CLIENT_ID', value: googleClientId ?? '' },
                  ...(calendarPublicUrl
                    ? [{ name: 'CALENDAR_PUBLIC_URL', value: calendarPublicUrl }]
                    : []),
                ]
              : []),
            ...Object.entries(secrets)
              .filter(([envName]) => calendarsOn || !calendarSecrets.has(envName))
              .map(([envName, secret]) => ({
                name: envName,
                valueSource: {
                  secretKeyRef: {
                    secret: secret.secretId,
                    version: secretVersions[secretEnv[envName]!] ?? 'latest',
                  },
                },
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
