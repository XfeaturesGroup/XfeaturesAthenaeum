import { buildRouter } from "./api/routes/index";
import type { Env, IngestionQueueMessage } from "./env";
import { handleQueueBatch } from "./queue/consumer";
import { purgeExpiredTrash } from "./maintenance/purge-trash";

export { KnowledgeCoreRpc } from "./rpc/entrypoint";
export { PublishWorkflow } from "./workflow/publish-workflow";

const router = buildRouter();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },
  async queue(batch: MessageBatch<IngestionQueueMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  /**
   * Trash retention is enforced here rather than on any request path, so the
   * 72-hour guarantee holds whether or not anybody opens the console. There is
   * deliberately no way to invoke this by hand: a manual purge would turn the
   * trash from a safety net into a delete button with extra steps.
   */
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      purgeExpiredTrash(env).then((outcome) => {
        if (outcome.eligible > 0 || outcome.failures.length > 0) {
          console.log(
            JSON.stringify({
              event: "trash_purge",
              eligible: outcome.eligible,
              purged: outcome.purged.length,
              objects_deleted: outcome.objectsDeleted,
              failures: outcome.failures.length
            })
          );
        }
      })
    );
  }
} satisfies ExportedHandler<Env, IngestionQueueMessage>;
