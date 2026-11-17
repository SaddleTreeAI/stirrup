import { Trans, useLingui } from "@lingui/react/macro";
import type {
  PlatformAdminBotInspection,
  PlatformAdminBotSummary,
  PlatformAdminCursor,
} from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

type Inspection = PlatformAdminBotInspection;

export function PlatformOwnerBotInspection({ userId }: { userId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [threadsBefore, setThreadsBefore] = useState<PlatformAdminCursor>();
  const [messagesBefore, setMessagesBefore] = useState<PlatformAdminCursor>();
  const [memoriesBefore, setMemoriesBefore] = useState<PlatformAdminCursor>();
  const [filesBefore, setFilesBefore] = useState<PlatformAdminCursor>();
  const [usageBefore, setUsageBefore] = useState<PlatformAdminCursor>();
  const [threads, setThreads] = useState<Inspection["threads"]>([]);
  const [messages, setMessages] = useState<Inspection["messages"]>([]);
  const [memories, setMemories] = useState<Inspection["memories"]>([]);
  const [files, setFiles] = useState<Inspection["files"]>([]);
  const [usage, setUsage] = useState<Inspection["usage"]>([]);
  const bots = useQuery(queries.platformAdmin.bots.listForUser.queryOptions({ input: { userId } }));
  const inspection = useQuery({
    ...queries.platformAdmin.bots.inspect.queryOptions({
      input: {
        botId: selectedBotId ?? "",
        ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        ...(threadsBefore ? { threadsBefore } : {}),
        ...(messagesBefore ? { before: messagesBefore } : {}),
        ...(memoriesBefore ? { memoriesBefore } : {}),
        ...(filesBefore ? { filesBefore } : {}),
        ...(usageBefore ? { usageBefore } : {}),
      },
    }),
    enabled: Boolean(selectedBotId),
  });
  useEffect(() => {
    const page = inspection.data;
    if (!page) return;
    if (!selectedThreadId && page.selectedThreadId) setSelectedThreadId(page.selectedThreadId);
    setThreads((current) => mergePage(current, page.threads, threadsBefore !== undefined));
    setMessages((current) => mergePage(current, page.messages, messagesBefore !== undefined, true));
    setMemories((current) => mergePage(current, page.memories, memoriesBefore !== undefined));
    setFiles((current) => mergePage(current, page.files, filesBefore !== undefined));
    setUsage((current) => mergePage(current, page.usage, usageBefore !== undefined));
  }, [
    inspection.data,
    selectedThreadId,
    threadsBefore,
    messagesBefore,
    memoriesBefore,
    filesBefore,
    usageBefore,
  ]);

  const resetInspection = () => {
    setSelectedBotId(null);
    setSelectedThreadId(undefined);
    setThreadsBefore(undefined);
    setMessagesBefore(undefined);
    setMemoriesBefore(undefined);
    setFilesBefore(undefined);
    setUsageBefore(undefined);
    setThreads([]);
    setMessages([]);
    setMemories([]);
    setFiles([]);
    setUsage([]);
  };
  const selectBot = (botId: string) => {
    if (selectedBotId === botId) return;
    resetInspection();
    setSelectedBotId(botId);
  };
  const selectThread = (threadId: string) => {
    if ((selectedThreadId ?? inspection.data?.selectedThreadId) === threadId) return;
    setSelectedThreadId(threadId);
    setMessagesBefore(undefined);
    setMessages([]);
  };

  return (
    <section className="space-y-3 border-t pt-4" data-testid="platform-owner-bot-inspection">
      <SectionHeading as="h3">
        <Trans>Bots and activity</Trans>
      </SectionHeading>
      {bots.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(bots.error, t`Could not load bots`)}
        </p>
      ) : bots.isPending ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Loading bots…</Trans>
        </p>
      ) : bots.data?.length ? (
        <ul className="divide-y rounded-lg border">
          {bots.data.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              selected={selectedBotId === bot.id}
              onSelect={() => selectBot(bot.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          <Trans>No bots</Trans>
        </p>
      )}
      {inspection.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(inspection.error, t`Could not inspect bot`)}
        </p>
      ) : null}
      {inspection.data ? (
        <div className="max-h-[65vh] space-y-4 overflow-y-auto rounded-lg border p-3">
          <div>
            <p className="font-medium">{inspection.data.bot.name}</p>
            <p className="text-body-sm text-muted-foreground">{inspection.data.bot.spaceName}</p>
            <p className="text-body-sm text-muted-foreground">{inspection.data.bot.ownerName}</p>
            <p className="text-body-sm text-muted-foreground">{inspection.data.bot.ownerEmail}</p>
            {inspection.data.bot.description ? (
              <p className="mt-2 text-body-sm">{inspection.data.bot.description}</p>
            ) : null}
            <details className="mt-2">
              <summary className="cursor-pointer text-body-sm font-medium">
                <Trans>Instructions and model</Trans>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-body-sm">
                {inspection.data.bot.instructions}
              </pre>
              <p className="mt-2 text-body-sm text-muted-foreground">
                {inspection.data.bot.modelProvider ?? "—"}
              </p>
              <p className="text-body-sm text-muted-foreground">
                {inspection.data.bot.modelId ?? "—"}
              </p>
            </details>
          </div>

          <section>
            <SectionHeading as="h4">
              <Trans>Conversations</Trans>
            </SectionHeading>
            {threads.length ? (
              <ul className="mt-2 divide-y rounded-lg border">
                {threads.map((thread) => {
                  const selected =
                    (selectedThreadId ?? inspection.data?.selectedThreadId) === thread.id;
                  return (
                    <li key={thread.id}>
                      <Button
                        variant={selected ? "secondary" : "ghost"}
                        className="h-auto w-full justify-start px-3 py-2 text-start"
                        onClick={() => selectThread(thread.id)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{thread.label}</span>
                          <span className="block text-label text-muted-foreground">
                            {thread.kind}
                          </span>
                          <time
                            className="block text-label text-muted-foreground"
                            dateTime={thread.createdAt}
                          >
                            {new Date(thread.createdAt).toLocaleString()}
                          </time>
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-body-sm text-muted-foreground">
                <Trans>No conversations</Trans>
              </p>
            )}
            {inspection.data.nextThreadsBefore ? (
              <Button
                variant="outline"
                className="mt-2"
                disabled={inspection.isFetching}
                onClick={() => setThreadsBefore(inspection.data?.nextThreadsBefore ?? undefined)}
              >
                <Trans>Load older conversations</Trans>
              </Button>
            ) : null}
          </section>

          <section>
            <SectionHeading as="h4">
              <Trans>Messages</Trans>
            </SectionHeading>
            <ol className="mt-2 space-y-2">
              {messages.map((message) => (
                <li key={message.id} className="rounded-md bg-muted/50 p-2">
                  <p className="text-label text-muted-foreground">{message.role}</p>
                  <time
                    className="block text-label text-muted-foreground"
                    dateTime={message.createdAt}
                  >
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-body-sm">
                    {message.blocks
                      .map((block) => (block.kind === "text" ? block.text : JSON.stringify(block)))
                      .join("\n")}
                  </pre>
                </li>
              ))}
            </ol>
            {inspection.data.nextBefore ? (
              <Button
                variant="outline"
                className="mt-2"
                disabled={inspection.isFetching}
                onClick={() => setMessagesBefore(inspection.data?.nextBefore ?? undefined)}
              >
                <Trans>Load older messages</Trans>
              </Button>
            ) : null}
          </section>

          <section>
            <SectionHeading as="h4">
              <Trans>Files</Trans>
            </SectionHeading>
            <ul className="mt-2 space-y-2">
              {files.map((file) => (
                <li key={file.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-body-sm">{file.name}</span>
                    <span className="block text-label text-muted-foreground">
                      {file.size.toLocaleString()} bytes
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const link = document.createElement("a");
                      link.href = `/api/platform-admin/bots/${encodeURIComponent(inspection.data.bot.id)}/files/${encodeURIComponent(file.id)}`;
                      link.download = file.name;
                      link.click();
                    }}
                  >
                    <Trans>Download</Trans>
                  </Button>
                </li>
              ))}
            </ul>
            {inspection.data.nextFilesBefore ? (
              <Button
                variant="outline"
                className="mt-2"
                disabled={inspection.isFetching}
                onClick={() => setFilesBefore(inspection.data?.nextFilesBefore ?? undefined)}
              >
                <Trans>Load older files</Trans>
              </Button>
            ) : null}
          </section>

          <details>
            <summary className="cursor-pointer text-body-sm font-medium">
              <Trans>Memories and usage</Trans>
            </summary>
            <div className="mt-2 space-y-4 text-body-sm">
              <section>
                <p className="font-medium">
                  <Trans>Memories</Trans>
                </p>
                {memories.map((memory) => (
                  <div key={memory.id} className="py-1">
                    <p className="break-words">{memory.path}</p>
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {memory.content}
                    </p>
                  </div>
                ))}
                {inspection.data.nextMemoriesBefore ? (
                  <Button
                    variant="outline"
                    className="mt-2"
                    disabled={inspection.isFetching}
                    onClick={() =>
                      setMemoriesBefore(inspection.data?.nextMemoriesBefore ?? undefined)
                    }
                  >
                    <Trans>Load older memories</Trans>
                  </Button>
                ) : null}
              </section>
              <section>
                <p className="font-medium">
                  <Trans>Usage</Trans>
                </p>
                {usage.map((record) => (
                  <div key={record.id} className="py-1">
                    <p>{record.provider}</p>
                    <p className="text-muted-foreground">{record.model}</p>
                    <p className="text-muted-foreground">{record.costUsd ?? "—"}</p>
                  </div>
                ))}
                {inspection.data.nextUsageBefore ? (
                  <Button
                    variant="outline"
                    className="mt-2"
                    disabled={inspection.isFetching}
                    onClick={() => setUsageBefore(inspection.data?.nextUsageBefore ?? undefined)}
                  >
                    <Trans>Load older usage</Trans>
                  </Button>
                ) : null}
              </section>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function mergePage<T extends { id: string }>(
  current: T[],
  page: T[],
  append: boolean,
  olderFirst = false,
) {
  if (!append) return page;
  const known = new Set(current.map(({ id }) => id));
  const newRows = page.filter(({ id }) => !known.has(id));
  return olderFirst ? [...newRows, ...current] : [...current, ...newRows];
}

function BotRow({
  bot,
  selected,
  onSelect,
}: {
  bot: PlatformAdminBotSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <Button
        variant={selected ? "secondary" : "ghost"}
        className="h-auto w-full justify-start px-3 py-2 text-start"
        onClick={onSelect}
      >
        <span className="min-w-0">
          <span className="block truncate">{bot.name}</span>
          <span className="block truncate text-label text-muted-foreground">{bot.spaceName}</span>
        </span>
      </Button>
    </li>
  );
}
