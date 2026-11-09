# infra

Pulumi (TypeScript) for planner-backend on Google Cloud. One stack per environment: `dev`, `prod`.

Creates: the APIs it needs, an Artifact Registry repo (`planner`), Secret Manager secrets, the
API's service account, and the Cloud Run service (public; the API checks Supabase tokens itself).

**Not applied yet.** It needs a GCP project (blocked on Samuel). It only typechecks for now:

```bash
cd infra && pnpm install && pnpm typecheck
```

## First deploy (once the GCP project exists)

```bash
cd infra
pulumi login                      # Pulumi Cloud, or: pulumi login gs://<state-bucket>
pulumi stack init dev
pulumi config set gcp:project <project-id>
pulumi config set gcp:region us-central1
pulumi config set supabaseUrl https://<ref>.supabase.co
pulumi up                         # first run deploys Cloud Run's sample image

# Secret values (never in Pulumi state):
printf '%s' '<postgres connection string>' | \
  gcloud secrets versions add planner-database-url --data-file=-

# Build and push the API image, then point the service at it:
docker build -t <region>-docker.pkg.dev/<project>/planner/api:<tag> .. && docker push ...
pulumi config set imageTag <tag> && pulumi up
```

Set `legacyJwtSecret: true` only if the Supabase project still signs tokens with HS256.

## Still to add
- Workload Identity Federation + a deploy service account, so GitHub Actions can push and deploy.
- Cloud Scheduler for the Google Calendar worker (watch-channel renewal).
- A custom domain.
