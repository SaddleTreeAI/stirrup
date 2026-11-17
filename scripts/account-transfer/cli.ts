import { parseArgs } from "node:util";
import type { ExportScope } from "./bundle.js";
import { exportBundle, keygen } from "./export.js";
import { importBundle } from "./import.js";

function list(value: string | undefined): string[] {
  if (!value) return [];
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.some((item) => item.length > 200) || new Set(values).size !== values.length)
    throw new Error("Invalid identifier list");
  return values;
}

function flags(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      private: { type: "string" },
      public: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      "recipient-public-key": { type: "string" },
      "recipient-private-key": { type: "string" },
      "user-id": { type: "string" },
      "organization-id": { type: "string" },
      "space-id": { type: "string" },
      "bot-ids": { type: "string" },
      "mcp-server-ids": { type: "string" },
      "credential-ids": { type: "string" },
      "exclude-credential-ids": { type: "string" },
      "connection-ids": { type: "string" },
      "space-memory-config-ids": { type: "string" },
      "agent-secret-ids": { type: "string" },
      "agent-skill-ids": { type: "string" },
      "capability-install-ids": { type: "string" },
      "board-ids": { type: "string" },
      "shared-memory-document-ids": { type: "string" },
      "bot-deletion-ids": { type: "string" },
      "external-refs-output": { type: "string" },
      "expected-schema-fingerprint": { type: "string" },
      "dry-run": { type: "boolean" },
      "rehearsal-export": { type: "boolean" },
    },
  });
  return { values, positionals };
}

function requireIds(values: string[], kind: string) {
  if (!values.length) throw new Error(`At least one ${kind} is required`);
  return values;
}

async function main() {
  const { values, positionals } = flags(process.argv.slice(2));
  const command = positionals[0];
  if (values["rehearsal-export"] && (command !== "export" || values["dry-run"]))
    throw new Error("--rehearsal-export requires export without --dry-run");
  if (command === "keygen") {
    if (!values.private || !values.public)
      throw new Error("Usage: account-transfer keygen --private <file> --public <file>");
    await keygen(values.private, values.public);
    return;
  }
  if (command === "export") {
    const scope: ExportScope = {
      userId: String(values["user-id"] ?? ""),
      organizationId: String(values["organization-id"] ?? ""),
      spaceId: String(values["space-id"] ?? ""),
      botIds: requireIds(list(values["bot-ids"]), "bot ID"),
      mcpServerIds: list(values["mcp-server-ids"]),
      credentialIds: list(values["credential-ids"]),
      connectionIds: list(values["connection-ids"]),
      spaceMemoryConfigIds: list(values["space-memory-config-ids"]),
      agentSecretIds: list(values["agent-secret-ids"]),
      agentSkillIds: list(values["agent-skill-ids"]),
      capabilityInstallIds: list(values["capability-install-ids"]),
      boardIds: list(values["board-ids"]),
      sharedMemoryDocumentIds: list(values["shared-memory-document-ids"]),
      botDeletionIds: list(values["bot-deletion-ids"]),
      excludedCredentialIds: list(values["exclude-credential-ids"]),
    };
    if (!scope.userId || !scope.organizationId || !scope.spaceId)
      throw new Error("User, organization, and Space IDs are required");
    if (!values.output || !values["recipient-public-key"])
      throw new Error("Output path and recipient public key are required");
    await exportBundle({
      output: values.output,
      publicKeyFile: values["recipient-public-key"],
      scope,
      dryRun: Boolean(values["dry-run"]),
      rehearsalExport: Boolean(values["rehearsal-export"]),
      expectedSchemaFingerprint: values["expected-schema-fingerprint"],
      externalRefsOutput: values["external-refs-output"],
    });
    return;
  }
  if (command === "import") {
    if (!values.input || !values["recipient-private-key"])
      throw new Error("Input bundle and recipient private key are required");
    await importBundle({
      input: values.input,
      privateKeyFile: values["recipient-private-key"],
      dryRun: Boolean(values["dry-run"]),
    });
    return;
  }
  throw new Error("Usage: account-transfer <keygen|export|import> [options]");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Transfer operation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
