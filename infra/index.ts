import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');
const project = gcpConfig.require('project');
const region = gcpConfig.require('region');
const stack = pulumi.getStack();

const supabaseUrl = config.require('supabaseUrl');
// The image to run: a tag in Artifact Registry (default `main`, the branch). Pulumi looks up the
// digest that tag points to now and deploys that, so pushing a new `:main` image and running
// `pulumi up` rolls it out (Cloud Run pins digests, so a moving tag alone wouldn't redeploy).
// An exact tag (a commit sha) also works, for pinning or rolling back.
const imageTag = config.get('imageTag') ?? 'main';
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
// Outlook (Microsoft Graph). Same two passes as Google: `pulumi up` creates the secret, you add its
// value, then set `microsoftClientId` and `pulumi up` again (only then does the API reference it).
const microsoftClientId = config.get('microsoftClientId');
const calendarPublicUrl = config.get('calendarPublicUrl');

const name = (suffix: string) => `planner-${suffix}-${stack}`;

const apis = [
  'run',
  'artifactregistry',
  'secretmanager',
  'iam',
  'cloudtasks',
  'cloudscheduler',
].map(
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
const image = gcp.artifactregistry
  .getDockerImageOutput({
    location: region,
    repositoryId: registry.repositoryId,
    imageName: `api:${imageTag}`,
  })
  // selfLink is `<host>/<project>/<repo>/<image>@sha256:…`: deploy by digest.
  .apply((img) => pulumi.interpolate`${imageBase}@${img.selfLink.split('@')[1]}`);

const runner = new gcp.serviceaccount.Account('api-runner', {
  accountId: name('api'),
  displayName: `planner-backend API (${stack})`,
});

const secretEnv: Record<string, string> = {
  DATABASE_URL: 'database-url',
  ...(config.getBoolean('legacyJwtSecret') && { SUPABASE_JWT_SECRET: 'supabase-jwt-secret' }),
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
  // Must stay the same key forever per environment: it decrypts every stored calendar login.
  CALENDAR_CREDENTIALS_KEY: 'calendar-credentials-key',
};
const calendarSecrets = new Set([
  'GOOGLE_CLIENT_SECRET',
  'CALENDAR_CREDENTIALS_KEY',
  'MICROSOFT_CLIENT_SECRET',
]);
/** Secrets the API only references once their provider is configured. */
const secretEnabled = (envName: string) =>
  envName === 'MICROSOFT_CLIENT_SECRET'
    ? calendarsOn && !!microsoftClientId
    : calendarsOn || !calendarSecrets.has(envName);

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

// ─── Calendar jobs: Cloud Tasks queue + Cloud Scheduler ────────────────────────────────────────
// The API queues jobs (webhook pings → syncs, switching calendars on) in Cloud Tasks; the queue
// and the scheduler call back into /jobs/calendar/<type> with an OIDC token for `jobsInvoker`,
// which that route requires. Needs `calendars: true` and `calendarPublicUrl` (the service URL).
const liveUpdates = calendarsOn && !!calendarPublicUrl;

const jobsInvoker = new gcp.serviceaccount.Account('calendar-jobs', {
  accountId: name('jobs'),
  displayName: `planner-backend calendar jobs caller (${stack})`,
});

const queue = new gcp.cloudtasks.Queue(
  'calendar-queue',
  {
    name: name('calendar'),
    location: region,
    // Keeps us well under Google Calendar's per-user limits.
    rateLimits: { maxDispatchesPerSecond: 10, maxConcurrentDispatches: 10 },
    retryConfig: { maxAttempts: 6, minBackoff: '10s', maxBackoff: '600s', maxDoublings: 4 },
  },
  { dependsOn: apis },
);
const queuePath = pulumi.interpolate`projects/${project}/locations/${region}/queues/${queue.name}`;

// The API adds tasks, and signs them as jobsInvoker.
new gcp.cloudtasks.QueueIamMember('calendar-queue-enqueuer', {
  name: queue.name,
  location: region,
  role: 'roles/cloudtasks.enqueuer',
  member: pulumi.interpolate`serviceAccount:${runner.email}`,
});
new gcp.serviceaccount.IAMMember('calendar-jobs-actas', {
  serviceAccountId: jobsInvoker.name,
  role: 'roles/iam.serviceAccountUser',
  member: pulumi.interpolate`serviceAccount:${runner.email}`,
});

if (liveUpdates) {
  const schedule = (id: string, cron: string, type: string, description: string) =>
    new gcp.cloudscheduler.Job(
      id,
      {
        name: name(id),
        region,
        description,
        schedule: cron,
        timeZone: 'Etc/UTC',
        attemptDeadline: '180s',
        httpTarget: {
          httpMethod: 'POST',
          uri: `${calendarPublicUrl!.replace(/\/$/, '')}/jobs/calendar/${type}`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from('{}').toString('base64'),
          oidcToken: {
            serviceAccountEmail: jobsInvoker.email,
            audience: calendarPublicUrl!,
          },
        },
      },
      { dependsOn: apis },
    );
  schedule('calendar-poll', '*/20 * * * *', 'poll', 'Backup sync of every calendar');
  schedule(
    'calendar-renew',
    // Every 12 hours: Graph subscriptions last about 3 days, Google's about a week.
    '17 */12 * * *',
    'renew-subscriptions',
    'Renew webhook subscriptions that expire within 36 hours',
  );
  schedule(
    'calendar-rebaseline',
    '41 3 * * 1',
    'rebaseline',
    'Move fixed sync windows (Outlook) forward',
  );
}

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
          // Without the queue (calendars on, no public URL) jobs run in-process after the
          // response, so the CPU must stay on between requests.
          resources: {
            limits: { cpu: '1', memory: '512Mi' },
            cpuIdle: !calendarsOn || liveUpdates,
          },
          startupProbe: { httpGet: { path: '/health' } },
          envs: [
            { name: 'SUPABASE_URL', value: supabaseUrl },
            { name: 'CORS_ORIGINS', value: corsOrigins },
            ...(calendarsOn
              ? [
                  { name: 'GOOGLE_CLIENT_ID', value: googleClientId ?? '' },
                  ...(microsoftClientId
                    ? [{ name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }]
                    : []),
                  // The web app may be returned to after connecting a calendar.
                  { name: 'CALENDAR_WEB_ORIGINS', value: corsOrigins },
                  ...(liveUpdates
                    ? [
                        { name: 'CALENDAR_PUBLIC_URL', value: calendarPublicUrl! },
                        { name: 'CALENDAR_QUEUE', value: 'cloud-tasks' },
                        { name: 'CALENDAR_TASKS_QUEUE', value: queuePath },
                        { name: 'CALENDAR_JOBS_URL', value: calendarPublicUrl! },
                        { name: 'CALENDAR_JOBS_INVOKER', value: jobsInvoker.email },
                      ]
                    : []),
                ]
              : []),
            ...Object.entries(secrets)
              .filter(([envName]) => secretEnabled(envName))
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
export const calendarQueue = queuePath;
export const calendarJobsInvoker = jobsInvoker.email;
