# Rotating credentials without downtime

Credentials age, leak and get revoked, so every service that holds one needs a way to swap it for a new one while requests keep flowing. This page walks through the two-key pattern our services use.

> [!WARNING]
> **Revoke last**
>
> Never revoke the old key before every instance reports the new one in its health check.

Each service reads two keys from its secret store, the current one and the next one, and accepts tokens signed with either. Rotation is then a matter of promoting the next key and generating a fresh one behind it.

> [!TIP]
> **Dry run first**
>
> Run the rotation against the staging store with the dry-run flag; it prints every service it would touch.

The promotion step is idempotent, so a rotation interrupted halfway can simply be started again from the beginning.

> [!NOTE]
> Services that cache keys in memory pick up the new key on their next refresh, at most five minutes later.

Once the dashboards show no traffic signed with the old key for a full day, it can be revoked safely.
