import { buildRouter } from "./api/routes/index";
import type { Env, IngestionQueueMessage } from "./env";
import { handleQueueBatch } from "./queue/consumer";

export { KnowledgeCoreRpc } from "./rpc/entrypoint";
export { PublishWorkflow } from "./workflow/publish-workflow";

const router = buildRouter();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },
  async queue(batch: MessageBatch<IngestionQueueMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  }
} satisfies ExportedHandler<Env, IngestionQueueMessage>;
