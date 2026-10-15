-- Dev-only bootstrap for the compose stack (FRI-2004).
--
-- Stands in for the provisioning step that, in the cloud, belongs to the
-- Control plane and runs BEFORE the Deployment container starts (ADR-051,
-- FRI-2005). Mirrors that split deliberately: a superuser creates the role and
-- the `vector` extension here, and the Deployment's own role never holds the
-- privilege to do either. Runs once, on first initialisation of the volume.

CREATE ROLE friday WITH LOGIN PASSWORD 'friday' REPLICATION;
GRANT ALL PRIVILEGES ON DATABASE friday TO friday;

\connect friday

-- Needs SUPERUSER, which is why it cannot live in a migration or on the
-- Deployment's boot path (ADR-044).
CREATE EXTENSION IF NOT EXISTS vector;

-- The Friday role owns the schema it migrates into, and must be able to create
-- the publication zero-cache replicates from.
ALTER SCHEMA public OWNER TO friday;
GRANT ALL ON SCHEMA public TO friday;
