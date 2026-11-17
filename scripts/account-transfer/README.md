# Selective account transfer

This operator tool moves one explicitly selected owner, organization, Space, bot set, MCP server set, and model credential set. It preserves database identifiers and conversation/usage history. Source `ENCRYPTION_KEY` and master keys never enter the bundle or target. Space data keys and selected secret values are opened on the source, sealed to a one-time recipient key, then rewrapped under the target's configured keys during import.

The bundle contains private account and conversation metadata. Keep it in owner-only storage, transfer it only through the approved private file path, and remove it after verification. The source process prints table counts, schema fingerprint, and intentional omitted table names only. It does not print rows, credential values, hostnames, or key material. The encrypted bundle contains its own omission manifest for excluded credential IDs, routines disabled on import, and deployment-specific tables left on the source.

The model credential selection may be empty when all providers require fresh authentication. Explicitly list those credentials in `--exclude-credential-ids`; they appear in the reconnect manifest. A selected credential with a missing secret is rejected during the source dry run as well as export.

## Rehearsal and cutover

To validate a full target import before pausing live source work, run export with `--rehearsal-export` instead of `--dry-run`. It preserves the same ownership, table, relationship, and encryption checks, while allowing active source runs and computers in the consistent read snapshot. The resulting bundle is marked `rehearsal`; the importer rejects it unless `--dry-run` is supplied, before opening a target database connection. It cannot serve as the final cutover bundle. After the source is paused, create a new normal export and repeat target verification.

Run the same checked-out revision and its installed dependencies on both environments. Build the one-off CLI bundle in the workspace and copy that private operator artifact to the source and target app checkouts; it leaves the `@rakazo/*` packages external so each environment uses its installed database/key-manager code:

```sh
node_modules/.bin/esbuild scripts/account-transfer/cli.ts \
  --bundle --platform=node --format=esm --packages=external --tsconfig-raw='{}' \
  --outfile=apps/api/.account-transfer-cli.mjs
```

Run the bundle through the app's TSX runtime from its checkout, then remove it after the transfer:

```sh
pnpm exec tsx apps/api/.account-transfer-cli.mjs <command> [options]
```

Set each environment's `DATABASE_URL` and existing encryption/key-manager configuration through its normal secret manager. Never put secret values in command arguments or tracked files. Point the source process at the verified source database and the target process at the new, migrated target database.

1. On the target, create a one-time recipient keypair in a private working directory. Keep the private key on the target operator host; copy only the public key to the source operator host.

   ```sh
   pnpm exec tsx apps/api/.account-transfer-cli.mjs keygen \
     --private /secure/pb-transfer-private.pem \
     --public /secure/pb-transfer-public.pem
   ```

2. On the source, rehearse scope and relationship checks without writing a bundle. Use the verified IDs for this single owner and Space. `--credential-ids` is a required allowlist; list only credentials approved for transfer. List credentials that must reconnect with `--exclude-credential-ids` (for example, a rotating OAuth credential). Those lists must not overlap.

   ```sh
   pnpm exec tsx apps/api/.account-transfer-cli.mjs export \
     --user-id '<SOURCE_USER_ID>' \
     --organization-id '<SOURCE_ORGANIZATION_ID>' \
     --space-id '<SOURCE_SPACE_ID>' \
     --bot-ids '<BOT_ID_1>,<BOT_ID_2>' \
     --mcp-server-ids '<MCP_SERVER_ID_1>,<MCP_SERVER_ID_2>' \
     --credential-ids '<MODEL_CREDENTIAL_ID>' \
     --exclude-credential-ids '<CREDENTIAL_ID_REQUIRING_REAUTH>' \
     --connection-ids '<REVIEWED_CONNECTION_IDS_OR_EMPTY>' \
     --space-memory-config-ids '<REVIEWED_MEMORY_CONFIG_IDS_OR_EMPTY>' \
     --agent-secret-ids '<REVIEWED_AGENT_SECRET_IDS_OR_EMPTY>' \
     --agent-skill-ids '<REVIEWED_AGENT_SKILL_IDS_OR_EMPTY>' \
     --capability-install-ids '<REVIEWED_INSTALL_IDS_OR_EMPTY>' \
     --board-ids '<REVIEWED_BOARD_IDS_OR_EMPTY>' \
     --shared-memory-document-ids '<REVIEWED_PB_BEH_ARCHIVE_IDS_OR_EMPTY>' \
     --bot-deletion-ids '<REVIEWED_PB_ARCHIVED_BOT_RECORD_IDS_OR_EMPTY>' \
     --external-refs-output /secure/pb-external-files.json \
     --recipient-public-key /secure/pb-transfer-public.pem \
     --output /secure/pb-account-transfer.json \
     --dry-run
   ```

   The source read uses a repeatable-read, read-only transaction. It confirms the selected Space has exactly one member, that every selected bot and MCP server belongs to the named owner and Space, and that the exported graph has no unsupported or unresolved foreign-key records. It also reports selected table and row counts plus a schema fingerprint for this exact scope. Save that fingerprint for the export. The optional external reference manifest is private and contains only selected artifact storage keys and computer home storage references for the separate file copy. A failure is a stop condition: do not broaden a filter to make it pass; resolve the specific relationship or add reviewed table policy first.

3. After the source is paused and drained by the operator, run the same `export` command without `--dry-run` and pin the fingerprint printed by the successful dry-run:

   ```sh
   pnpm exec tsx apps/api/.account-transfer-cli.mjs export \
     --user-id '<SOURCE_USER_ID>' \
     --organization-id '<SOURCE_ORGANIZATION_ID>' \
     --space-id '<SOURCE_SPACE_ID>' \
     --bot-ids '<BOT_ID_1>,<BOT_ID_2>' \
     --mcp-server-ids '<MCP_SERVER_ID_1>,<MCP_SERVER_ID_2>' \
     --credential-ids '<MODEL_CREDENTIAL_ID>' \
     --exclude-credential-ids '<CREDENTIAL_ID_REQUIRING_REAUTH>' \
     --connection-ids '<REVIEWED_CONNECTION_IDS_OR_EMPTY>' \
     --space-memory-config-ids '<REVIEWED_MEMORY_CONFIG_IDS_OR_EMPTY>' \
     --agent-secret-ids '<REVIEWED_AGENT_SECRET_IDS_OR_EMPTY>' \
     --agent-skill-ids '<REVIEWED_AGENT_SKILL_IDS_OR_EMPTY>' \
     --capability-install-ids '<REVIEWED_INSTALL_IDS_OR_EMPTY>' \
     --board-ids '<REVIEWED_BOARD_IDS_OR_EMPTY>' \
     --shared-memory-document-ids '<REVIEWED_PB_BEH_ARCHIVE_IDS_OR_EMPTY>' \
     --bot-deletion-ids '<REVIEWED_PB_ARCHIVED_BOT_RECORD_IDS_OR_EMPTY>' \
     --expected-schema-fingerprint '<FINGERPRINT_FROM_DRY_RUN>' \
     --recipient-public-key /secure/pb-transfer-public.pem \
     --output /secure/pb-account-transfer.json
   ```

   It writes the bundle with mode `0600`; it refuses to overwrite an existing path. Copy the bundle to the target using the approved private transfer method. The public key can be discarded after export.

4. On the target, validate the bundle, target schema compatibility, identifiers, keys, secrets, and all selected inserts in one transaction that is rolled back at the end. This is the target rehearsal and writes no committed rows:

   ```sh
   pnpm exec tsx apps/api/.account-transfer-cli.mjs import \
     --input /secure/pb-account-transfer.json \
     --recipient-private-key /secure/pb-transfer-private.pem \
     --dry-run
   ```

5. When the target dry-run succeeds and the target is still the intended empty account, run the same command without `--dry-run`. The import transaction either commits the selected rows and rewrapped Space keys together or rolls back. Existing primary-key conflicts fail before writes; unique conflicts fail the transaction. Re-running a committed bundle is intentionally refused as a conflict rather than overwriting the target.

6. Verify the target through the application and operator's selected counts/file manifest. Keep the source disabled for the approved retention window to support rollback. The operator owns service pause, filesystem selection, routine enablement, cutover, and rollback; this CLI does not contact hosts, change DNS, copy files, or enable routines. Routines are imported inactive, computers are stopped with provider/lease references cleared, and omitted rotating OAuth credentials require fresh target authentication.

## Scope and fail-closed edges

The export policy includes the named account, password-backed sign-in row, verified sole-member organization and Space memberships with their owner roles preserved, selected bots and their groups/conversations/history/runs/attempts/usage/memory/artifact metadata, selected account/Space integration settings, explicitly selected or assigned MCP servers, explicitly selected connections, memory configurations, shared memory documents, agent secrets, agent skills, capability installs, and boards, plus explicitly selected model credentials. Shared memory documents (including PB/BEH archives) must be listed by ID; documents belonging to other bots are never inferred from a null bot reference. Other accounts, non-selected bots, login sessions, OAuth/passkey session state, payment/billing rows, work leases/queues, and Codex's rotating OAuth token are not copied.

Export stops for remote secret-store references, legacy plaintext MCP arguments/environment/files/headers, unselected participants in a selected group, data in an unhandled Space-scoped table, unresolved foreign keys, active runs/tasks, missing keys, incompatible target columns, or conflicting target IDs. This first cut intentionally supports the verified single-member Space graph; it does not clone a shared organization or shared Space.
