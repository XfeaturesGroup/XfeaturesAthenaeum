import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FactProposalsService } from "../../src/knowledge/fact-proposals";
import { FactsService } from "../../src/knowledge/facts";
import { FactProposalsRepository } from "../../src/repositories/fact-proposals.repository";
import { FactsRepository } from "../../src/repositories/facts.repository";
import { ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

/** The MCP role: may propose, may not write. */
let contributor: SeededAgent;
/** A human reviewer with the full fact surface. */
let reviewer: SeededAgent;
/** admin.facts + facts.write, but PUBLIC clearance and the products namespace only. */
let limitedReviewer: SeededAgent;

let proposals: FactProposalsService;
let facts: FactsService;
let repo: FactsRepository;

/**
 * Facts an agent has asked a human to accept (migration 0006).
 *
 * The whole point of the feature is a sentence: nothing an agent proposes
 * changes what the platform answers until a person with `facts.write` says so.
 * These tests are that sentence, plus the ways round it that a proposal queue
 * invites -- proposing into a tier you cannot read, having a weaker reviewer
 * rubber-stamp something they cannot see, and applying a proposal written
 * against a value that has since changed.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  contributor = await createAgent(testEnv, "proposing-agent", "content-contributor");
  reviewer = await createAgent(testEnv, "fact-reviewer", "knowledge-admin");
  limitedReviewer = await createAgent(testEnv, "narrow-reviewer", "narrow-fact-reviewer");

  repo = new FactsRepository(testEnv.DB);
  facts = new FactsService(repo);
  proposals = new FactProposalsService(new FactProposalsRepository(testEnv.DB), repo);
});

beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM fact_proposals").run();
  await testEnv.DB.prepare("DELETE FROM fact_versions").run();
  await testEnv.DB.prepare("DELETE FROM facts").run();
  await createFact(testEnv, "products", "widget-price", "PUBLIC", { amount: 10 });
  await createFact(testEnv, "plans", "annual-pro", "INTERNAL", { amount: 990 });
  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret" });
});

describe("proposing is asking, not writing", () => {
  it("does not change what the platform answers", async () => {
    await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC", rationale: "Price list says 12." },
      contributor.agentId,
    );

    // The whole guarantee, in one assertion.
    const fact = await facts.getFact(reviewer.principal, "products", "widget-price");
    expect(fact.value).toEqual({ amount: 10 });
    expect(fact.version).toBe(1);
  });

  it("does not put the proposed value anywhere a reader can reach it", async () => {
    await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "unlisted-thing", value: { amount: 999 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    // Not a fact, not a deprecated fact, not a trashed fact -- not in the facts
    // table at all, which is what makes "one forgotten WHERE clause" impossible.
    await expect(facts.getFact(reviewer.principal, "products", "unlisted-thing")).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND
    });
    const listed = await facts.listFactsForAdmin(reviewer.principal, { limit: 50, offset: 0 });
    expect(listed.map((entry) => entry.key)).not.toContain("unlisted-thing");
  });

  it("refuses an agent that holds no propose permission", async () => {
    const reader = await createAgent(testEnv, `plain-reader-${crypto.randomUUID()}`, "support-agent");

    await expect(
      proposals.propose(
        reader.principal,
        { namespace: "products", key: "widget-price", value: { amount: 1 }, classification: "PUBLIC" },
        reader.agentId,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("refuses to file into a namespace or tier the proposer cannot read", async () => {
    // Otherwise a proposal queue becomes a way to launder a value into a tier
    // its author was never allowed to see.
    await expect(
      proposals.propose(
        contributor.principal,
        { namespace: "secrets", key: "planted", value: { value: "x" }, classification: "PUBLIC" },
        contributor.agentId,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await expect(
      proposals.propose(
        contributor.principal,
        { namespace: "products", key: "planted", value: { value: "x" }, classification: "RESTRICTED" },
        contributor.agentId,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("cannot approve what it proposed", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    // Human-in-the-loop is a permission, not a convention: the proposing role
    // holds facts.propose and nothing else that could apply it.
    await expect(
      proposals.approve(contributor.principal, proposal.id, contributor.agentId),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await expect(
      proposals.reject(contributor.principal, proposal.id, contributor.agentId),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe("approval happens under the reviewer's authority", () => {
  it("writes the fact as a new version, crediting the reviewer", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    const applied = await proposals.approve(reviewer.principal, proposal.id, reviewer.agentId, "Checked the price list.");

    expect(applied.fact.value).toEqual({ amount: 12 });
    expect(applied.fact.version).toBe(2);
    expect(applied.proposal.status).toBe("approved");

    const row = await repo.getActive("products", "widget-price");
    expect(row?.updated_by).toBe(reviewer.agentId);
  });

  it("creates a fact that did not exist before", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "plans", key: "monthly-lite", value: { amount: 5 }, classification: "INTERNAL" },
      contributor.agentId,
    );

    const applied = await proposals.approve(reviewer.principal, proposal.id, reviewer.agentId);

    expect(applied.fact.version).toBe(1);
    await expect(facts.getFact(reviewer.principal, "plans", "monthly-lite")).resolves.toMatchObject({
      value: { amount: 5 }
    });
  });

  it("refuses a reviewer who cannot read the tier being written", async () => {
    // The escalation this closes: a proposal is filed against a fact the
    // narrow reviewer cannot see, and approving it would write that fact
    // anyway. The reviewer's own permissions decide, not the proposer's.
    const proposal = await proposals.propose(
      reviewer.principal,
      { namespace: "plans", key: "annual-pro", value: { amount: 1090 }, classification: "INTERNAL" },
      reviewer.agentId,
    );

    await expect(
      proposals.approve(limitedReviewer.principal, proposal.id, limitedReviewer.agentId),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN, publicCode: ErrorCode.NOT_FOUND });

    const untouched = await repo.getActive("plans", "annual-pro");
    expect(untouched?.version).toBe(1);
  });

  it("refuses to reclassify past what the reviewer holds", async () => {
    const proposal = await proposals.propose(
      reviewer.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "RESTRICTED" },
      reviewer.agentId,
    );

    // The narrow reviewer can read the fact as it stands (PUBLIC/products) but
    // not the tier it would be moved into.
    await expect(
      proposals.approve(limitedReviewer.principal, proposal.id, limitedReviewer.agentId),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("refuses a proposal written against a value that has since changed", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    // Somebody corrected the price in the meantime. Applying the proposal now
    // would silently undo them.
    await repo.update("products", "widget-price", { valueJson: JSON.stringify({ amount: 11 }), updatedBy: reviewer.agentId });

    await expect(proposals.approve(reviewer.principal, proposal.id, reviewer.agentId)).rejects.toMatchObject({
      code: ErrorCode.STALE_VERSION
    });

    const row = await repo.getActive("products", "widget-price");
    expect(JSON.parse(row?.value_json ?? "{}")).toEqual({ amount: 11 });
  });

  it("refuses when the target fact has been deleted since it was proposed", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    await facts.moveToTrash(reviewer.principal, "products", "widget-price", reviewer.agentId);

    // Recreating it silently would undo the deletion.
    await expect(proposals.approve(reviewer.principal, proposal.id, reviewer.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });
  });

  it("can only be applied once, however many reviewers open the queue", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    await proposals.approve(reviewer.principal, proposal.id, reviewer.agentId);
    await expect(proposals.approve(reviewer.principal, proposal.id, reviewer.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });

    const row = await repo.getActive("products", "widget-price");
    expect(row?.version).toBe(2);
  });
});

describe("rejection records a decision and writes nothing", () => {
  it("keeps the fact exactly as it was, with the reviewer's note", async () => {
    const proposal = await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 99 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    const rejected = await proposals.reject(reviewer.principal, proposal.id, reviewer.agentId, "That is the list price, not ours.");

    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewNote).toBe("That is the list price, not ours.");

    const row = await repo.getActive("products", "widget-price");
    expect(JSON.parse(row?.value_json ?? "{}")).toEqual({ amount: 10 });
    expect(row?.version).toBe(1);
  });
});

describe("the review queue is bounded like every other listing", () => {
  it("hides a proposal the reader could not read as a fact", async () => {
    await proposals.propose(
      reviewer.principal,
      { namespace: "secrets", key: "master-key", value: { value: "new-secret" }, classification: "RESTRICTED" },
      reviewer.agentId,
    );
    await proposals.propose(
      contributor.principal,
      { namespace: "products", key: "widget-price", value: { amount: 12 }, classification: "PUBLIC" },
      contributor.agentId,
    );

    const queue = await proposals.list(limitedReviewer.principal, { limit: 50, offset: 0 });

    expect(queue.map((entry) => `${entry.namespace}/${entry.key}`)).toEqual(["products/widget-price"]);
    // An unreviewed value is not less sensitive than a reviewed one.
    expect(JSON.stringify(queue)).not.toContain("new-secret");
  });

  it("needs the administrative permission to open at all", async () => {
    await expect(proposals.list(contributor.principal, { limit: 50, offset: 0 })).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });
});
