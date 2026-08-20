-- Safe development seed: roles, the default permission taxonomy, and a
-- handful of synthetic PUBLIC/INTERNAL catalog rows for smoke testing.
-- Contains no real company data, tariffs, or credentials.
-- Agents are NOT seeded here -- create them through POST /v1/admin/agents so
-- the RPC key is generated and hashed server-side and only ever shown once.

-- ---------------------------------------------------------------------------
-- Permission taxonomy
-- ---------------------------------------------------------------------------

INSERT INTO permissions (id, key, description) VALUES
  ('perm_knowledge_search', 'knowledge.search', 'Call semantic search (searchKnowledge)'),

  ('perm_class_public', 'knowledge.classification.PUBLIC', 'May see PUBLIC-classified resources'),
  ('perm_class_internal', 'knowledge.classification.INTERNAL', 'May see INTERNAL-classified resources'),
  ('perm_class_confidential', 'knowledge.classification.CONFIDENTIAL', 'May see CONFIDENTIAL-classified resources'),
  ('perm_class_restricted', 'knowledge.classification.RESTRICTED', 'May see RESTRICTED-classified resources'),
  ('perm_class_all', 'knowledge.classification.*', 'May see resources of any classification'),

  ('perm_facts_read_products', 'facts.read.products', 'Read facts in the products namespace'),
  ('perm_facts_read_plans', 'facts.read.plans', 'Read facts in the plans namespace'),
  ('perm_facts_read_services', 'facts.read.services', 'Read facts in the services namespace'),
  ('perm_facts_read_policies', 'facts.read.policies', 'Read facts in the policies namespace'),
  ('perm_facts_read_all', 'facts.read.*', 'Read facts in any namespace'),
  ('perm_facts_write', 'facts.write', 'Create/update/deprecate facts'),

  ('perm_documents_read_public', 'documents.read.public', 'Read documents in the public domain'),
  ('perm_documents_read_support', 'documents.read.support', 'Read documents in the support domain'),
  ('perm_documents_read_billing', 'documents.read.billing', 'Read documents in the billing domain'),
  ('perm_documents_read_network', 'documents.read.network', 'Read documents in the network domain'),
  ('perm_documents_read_infrastructure', 'documents.read.infrastructure', 'Read documents in the infrastructure domain'),
  ('perm_documents_read_security', 'documents.read.security', 'Read documents in the security domain'),
  ('perm_documents_read_legal', 'documents.read.legal', 'Read documents in the legal domain'),
  ('perm_documents_read_runbooks', 'documents.read.runbooks', 'Read documents in the runbooks domain'),
  ('perm_documents_read_incidents', 'documents.read.incidents', 'Read documents in the incidents domain'),
  ('perm_documents_read_internal', 'documents.read.internal', 'Read documents in the generic internal domain'),
  ('perm_documents_read_all', 'documents.read.*', 'Read documents in any domain (still classification-gated)'),
  ('perm_documents_draft', 'documents.draft', 'File a NEW document as a draft and submit it for human review'),
  ('perm_documents_write', 'documents.write', 'Revise an existing document (add a version, roll back)'),
  ('perm_documents_publish', 'documents.publish', 'Publish/archive documents'),

  ('perm_products_read', 'products.read', 'Deterministic product lookups'),
  ('perm_prices_read', 'prices.read', 'Deterministic price/plan lookups'),

  ('perm_network_read', 'network.read', 'Read general network/infrastructure facts'),
  ('perm_network_restricted_read', 'network.restricted.read', 'Read restricted network/infrastructure facts'),

  ('perm_feedback_submit', 'feedback.submit', 'Submit knowledge feedback'),
  ('perm_audit_read', 'audit.read', 'Read audit events'),

  ('perm_admin_agents', 'admin.agents', 'Manage agent identities'),
  ('perm_admin_roles', 'admin.roles', 'Manage roles'),
  ('perm_admin_permissions', 'admin.permissions', 'Manage role-permission assignments'),
  ('perm_admin_ingestion', 'admin.ingestion', 'Trigger/inspect ingestion and reindex jobs'),
  ('perm_admin_facts', 'admin.facts', 'Administrative fact management'),
  ('perm_admin_documents', 'admin.documents', 'Administrative document management');

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

INSERT INTO roles (id, name, description) VALUES
  ('role_public_agent', 'public-agent', 'Public-facing chatbots. PUBLIC knowledge only.'),
  ('role_support_agent', 'support-agent', 'Internal support desk agents.'),
  ('role_billing_agent', 'billing-agent', 'Billing/finance-facing agents.'),
  ('role_network_agent', 'network-agent', 'Network/infrastructure agents. Elevated scope, still not RESTRICTED by default.'),
  ('role_internal_assistant', 'internal-assistant', 'General internal assistant. Broad domain read, PUBLIC/INTERNAL only.'),
  ('role_content_contributor', 'content-contributor', 'Drafts documents and submits them for human review. Cannot publish or approve -- for AI agents proposing knowledge updates over MCP.'),
  ('role_knowledge_admin', 'knowledge-admin', 'Xfeatures Athenaeum administrators.');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_public_agent', 'perm_knowledge_search'),
  ('role_public_agent', 'perm_class_public'),
  ('role_public_agent', 'perm_documents_read_public'),
  ('role_public_agent', 'perm_facts_read_products'),
  ('role_public_agent', 'perm_products_read'),
  ('role_public_agent', 'perm_feedback_submit'),

  ('role_support_agent', 'perm_knowledge_search'),
  ('role_support_agent', 'perm_class_public'),
  ('role_support_agent', 'perm_class_internal'),
  ('role_support_agent', 'perm_documents_read_public'),
  ('role_support_agent', 'perm_documents_read_support'),
  ('role_support_agent', 'perm_facts_read_products'),
  ('role_support_agent', 'perm_facts_read_plans'),
  ('role_support_agent', 'perm_facts_read_policies'),
  ('role_support_agent', 'perm_products_read'),
  ('role_support_agent', 'perm_prices_read'),
  ('role_support_agent', 'perm_feedback_submit'),

  ('role_billing_agent', 'perm_knowledge_search'),
  ('role_billing_agent', 'perm_class_public'),
  ('role_billing_agent', 'perm_class_internal'),
  ('role_billing_agent', 'perm_documents_read_public'),
  ('role_billing_agent', 'perm_documents_read_billing'),
  ('role_billing_agent', 'perm_facts_read_plans'),
  ('role_billing_agent', 'perm_facts_read_policies'),
  ('role_billing_agent', 'perm_prices_read'),
  ('role_billing_agent', 'perm_feedback_submit'),

  ('role_network_agent', 'perm_knowledge_search'),
  ('role_network_agent', 'perm_class_public'),
  ('role_network_agent', 'perm_class_internal'),
  ('role_network_agent', 'perm_class_confidential'),
  ('role_network_agent', 'perm_documents_read_public'),
  ('role_network_agent', 'perm_documents_read_network'),
  ('role_network_agent', 'perm_documents_read_infrastructure'),
  ('role_network_agent', 'perm_documents_read_runbooks'),
  ('role_network_agent', 'perm_facts_read_services'),
  ('role_network_agent', 'perm_network_read'),
  ('role_network_agent', 'perm_network_restricted_read'),
  ('role_network_agent', 'perm_feedback_submit'),

  ('role_internal_assistant', 'perm_knowledge_search'),
  ('role_internal_assistant', 'perm_class_public'),
  ('role_internal_assistant', 'perm_class_internal'),
  ('role_internal_assistant', 'perm_documents_read_all'),
  ('role_internal_assistant', 'perm_facts_read_all'),
  ('role_internal_assistant', 'perm_products_read'),
  ('role_internal_assistant', 'perm_prices_read'),
  ('role_internal_assistant', 'perm_feedback_submit'),

  ('role_content_contributor', 'perm_knowledge_search'),
  ('role_content_contributor', 'perm_class_public'),
  ('role_content_contributor', 'perm_class_internal'),
  ('role_content_contributor', 'perm_documents_read_all'),
  -- SR-025: draft-only. `documents.write` would let this identity rewrite
  -- every INTERNAL document in every domain over REST, and `admin.documents`
  -- would let it enumerate and open the whole corpus -- neither of which the
  -- MCP tools it was built for can even ask for. The MCP tool list is not a
  -- security boundary; the permission set is.
  ('role_content_contributor', 'perm_documents_draft'),
  ('role_content_contributor', 'perm_feedback_submit'),

  -- A knowledge administrator manages documents, so it also searches them:
  -- searching is strictly narrower than the document reads already granted.
  ('role_knowledge_admin', 'perm_knowledge_search'),
  ('role_knowledge_admin', 'perm_class_all'),
  ('role_knowledge_admin', 'perm_documents_read_all'),
  ('role_knowledge_admin', 'perm_facts_read_all'),
  ('role_knowledge_admin', 'perm_documents_draft'),
  ('role_knowledge_admin', 'perm_documents_write'),
  ('role_knowledge_admin', 'perm_documents_publish'),
  ('role_knowledge_admin', 'perm_facts_write'),
  ('role_knowledge_admin', 'perm_audit_read'),
  ('role_knowledge_admin', 'perm_admin_agents'),
  ('role_knowledge_admin', 'perm_admin_roles'),
  ('role_knowledge_admin', 'perm_admin_permissions'),
  ('role_knowledge_admin', 'perm_admin_ingestion'),
  ('role_knowledge_admin', 'perm_admin_facts'),
  -- Privilege containment (assertCanGrantRole) means an administrator can
  -- only ever hand out a role whose permissions it already holds itself.
  -- Without these five, knowledge-admin -- the role meant to administer
  -- every other one -- could not actually grant ANY operational role
  -- (public-agent, support-agent, billing-agent, network-agent,
  -- internal-assistant all carry at least one of them). An administrator
  -- role must be a genuine superset of what it administers.
  ('role_knowledge_admin', 'perm_feedback_submit'),
  ('role_knowledge_admin', 'perm_products_read'),
  ('role_knowledge_admin', 'perm_prices_read'),
  ('role_knowledge_admin', 'perm_network_read'),
  ('role_knowledge_admin', 'perm_network_restricted_read'),
  ('role_knowledge_admin', 'perm_admin_documents');

-- ---------------------------------------------------------------------------
-- Synthetic catalog fixtures (no real tariffs/products)
-- ---------------------------------------------------------------------------

INSERT INTO knowledge_sources (id, name, source_type, authority, reference) VALUES
  ('src_dev_fixture', 'Development fixture data', 'manual', 'unverified', 'seed/dev-seed.sql');

INSERT INTO products (id, code, name, description, category, status, classification, version, source_id) VALUES
  ('prod_demo_widget', 'demo-widget', 'Demo Widget', 'Synthetic product used only for local development and tests.', 'demo', 'active', 'PUBLIC', 1, 'src_dev_fixture');

INSERT INTO plans (id, code, product_id, name, description, price_amount, price_currency, billing_period, status, classification, version, source_id) VALUES
  ('plan_demo_basic', 'demo-widget-basic', 'prod_demo_widget', 'Demo Widget Basic', 'Synthetic plan used only for local development and tests.', 999, 'USD', 'monthly', 'active', 'PUBLIC', 1, 'src_dev_fixture');

INSERT INTO facts (id, namespace, key, version, value_json, title, classification, status, source_id) VALUES
  ('fact_demo_support_email', 'contacts', 'support-email', 1, '"support@example.invalid"', 'Support contact email', 'PUBLIC', 'active', 'src_dev_fixture');

INSERT INTO policies (id, code, title, body_markdown, classification, status, version, source_id) VALUES
  ('policy_demo_refund', 'demo-refund-policy', 'Demo Refund Policy', '# Demo Refund Policy\n\nThis is placeholder policy text for local development only.', 'PUBLIC', 'active', 1, 'src_dev_fixture');
