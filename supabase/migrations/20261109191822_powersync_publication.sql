-- PowerSync reads changes through Postgres logical replication, from this publication.
-- (On a cloud project, also create the replication role PowerSync connects as; see README.)
CREATE PUBLICATION powersync FOR TABLE tasks, habit_days, external_events;
