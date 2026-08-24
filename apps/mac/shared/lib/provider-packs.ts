import type { AgentRiskLevel, AgentWorkflow } from "../stores/agent-workflow-store";
import {
  renderCustomActionInput,
  sanitizeReviewedJsonSchema,
  validateReviewedJson,
  type ReviewedJsonSchema,
} from "./custom-integrations";

export const PROVIDER_PACK_IDS = [
  "google-workspace",
  "microsoft-365",
  "zendesk",
  "intercom",
  "stripe",
  "shopify",
  "hubspot",
  "salesforce",
  "sentry",
  "posthog",
  "datadog",
  "pagerduty",
  "supabase",
] as const;
export const PROVIDER_CONNECTIONS_CHANGED_EVENT = "codelit-provider-connections-changed";

export type ProviderPackId = (typeof PROVIDER_PACK_IDS)[number];
export type ProviderPackGroup = "work" | "support" | "revenue" | "engineering";
export type ProviderCredentialKey = "token" | "refreshToken" | "apiKey" | "appKey";

export interface ProviderConnectionField {
  key: string;
  label: string;
  placeholder: string;
  kind: "text" | "email" | "slug" | "hostname" | "choice";
  required: boolean;
  choices?: readonly { value: string; label: string }[];
  hint?: string;
}

export interface ProviderCredentialField {
  key: ProviderCredentialKey;
  label: string;
  placeholder: string;
  hint: string;
}

export interface ProviderPackOperation {
  id: string;
  surface: string;
  label: string;
  description: string;
  effect: "read" | "write";
  risk: AgentRiskLevel;
  scopes: readonly string[];
  idempotency: "read-only" | "required";
  evidence: readonly string[];
  inputSchema: ReviewedJsonSchema;
}

export interface ProviderPackDefinition {
  id: ProviderPackId;
  label: string;
  group: ProviderPackGroup;
  surfaces: readonly string[];
  namedUser: string;
  targetJob: string;
  docsUrl: string;
  credentialFields: readonly ProviderCredentialField[];
  connectionFields: readonly ProviderConnectionField[];
  operations: readonly ProviderPackOperation[];
  support: {
    rateLimit: string;
    errors: string;
    cost: string;
  };
}

export interface ProviderConnectionDraft {
  providerId: ProviderPackId;
  label: string;
  credentials: Partial<Record<ProviderCredentialKey, string>>;
  settings: Record<string, string>;
  expiresAt?: string;
}

export interface PublicProviderConnection {
  id: string;
  providerId: ProviderPackId;
  label: string;
  settings: Record<string, string>;
  status: "ready" | "expired" | "blocked";
  authType?: "credential" | "oauth";
  grantedScopes?: string[];
  accountId?: string;
  accountEmail?: string;
  avatar?: string;
  blockedReason?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOperationConfig {
  providerId: ProviderPackId;
  connectionId: string;
  operationId: string;
  connectionLabel: string;
  providerLabel: string;
  operationLabel: string;
  surface: string;
  effect: "read" | "write";
  risk: AgentRiskLevel;
  input: Record<string, unknown>;
}

const CONNECTION_ID = /^[A-Za-z0-9_-]{10,160}$/;
const OPERATION_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]{1,128}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const MAX_INPUT_BYTES = 24 * 1024;
const HANDOFF_VALUE = /^\{\{handoff(?:\.[A-Za-z][A-Za-z0-9_.-]{0,159})?\}\}$/;

const string = (maxLength = 2_000, description?: string, values?: readonly string[]): ReviewedJsonSchema => ({
  type: "string",
  maxLength,
  ...(description ? { description } : {}),
  ...(values?.length ? { enum: [...values] } : {}),
});

const object = (
  properties: Record<string, ReviewedJsonSchema>,
  required: readonly string[] = Object.keys(properties),
): ReviewedJsonSchema => ({ type: "object", properties, required: [...required], additionalProperties: false });

function operation(input: Omit<ProviderPackOperation, "idempotency" | "evidence">): ProviderPackOperation {
  return {
    ...input,
    idempotency: input.effect === "read" ? "read-only" : "required",
    evidence: input.effect === "read" ? ["bounded provider response"] : ["provider action receipt", "bounded provider response"],
  };
}

const bearer = (label = "Access token", hint = "Use the least-privileged token for this workspace."): readonly ProviderCredentialField[] => [
  { key: "token", label, placeholder: "Token", hint },
];

const none: readonly ProviderConnectionField[] = [];

const GOOGLE_OPERATIONS = [
  operation({ id: "google.gmail.search", surface: "Gmail", label: "Search messages", description: "Find up to ten messages matching one Gmail query.", effect: "read", risk: "low", scopes: ["gmail.readonly"], inputSchema: object({ query: string(500, "Gmail search query") }) }),
  operation({ id: "google.gmail.agent-team-inbox", surface: "Gmail", label: "Use Agent Team inbox", description: "Read bounded matching requests and post receipt-only replies in the original Gmail thread.", effect: "read", risk: "low", scopes: ["gmail.readonly", "gmail.send"], inputSchema: object({ query: string(500, "Gmail search query") }) }),
  operation({ id: "google.gmail.create-draft", surface: "Gmail", label: "Create draft", description: "Create one unsent RFC 2822 email draft after the workflow confirms outreach permission.", effect: "write", risk: "medium", scopes: ["gmail.compose"], inputSchema: object({ to: string(320), subject: string(240), body: string(8_000), outreachPermission: string(20, undefined, ["allowed", "blocked"]), campaignId: string(120) }, ["to", "subject", "body"]) }),
  operation({ id: "google.calendar.list-events", surface: "Calendar", label: "List events", description: "Read the next bounded set of events from one calendar.", effect: "read", risk: "low", scopes: ["calendar.readonly"], inputSchema: object({ calendarId: string(320) }) }),
  operation({ id: "google.calendar.create-event", surface: "Calendar", label: "Create event", description: "Create one timed event on an approved calendar.", effect: "write", risk: "medium", scopes: ["calendar.events"], inputSchema: object({ calendarId: string(320), summary: string(240), start: string(80, "RFC3339 start"), end: string(80, "RFC3339 end"), timeZone: string(80) }) }),
  operation({ id: "google.drive.search-files", surface: "Drive", label: "Search files", description: "Find up to ten non-trashed Drive files.", effect: "read", risk: "low", scopes: ["drive.metadata.readonly"], inputSchema: object({ query: string(500) }) }),
  operation({ id: "google.docs.read", surface: "Docs", label: "Read document", description: "Read one bounded Google document.", effect: "read", risk: "low", scopes: ["documents.readonly"], inputSchema: object({ documentId: string(200) }) }),
  operation({ id: "google.docs.append", surface: "Docs", label: "Append text", description: "Append bounded text to one Google document.", effect: "write", risk: "medium", scopes: ["documents"], inputSchema: object({ documentId: string(200), text: string(8_000) }) }),
  operation({ id: "google.sheets.read", surface: "Sheets", label: "Read range", description: "Read one A1 range from a spreadsheet.", effect: "read", risk: "low", scopes: ["spreadsheets.readonly"], inputSchema: object({ spreadsheetId: string(200), range: string(160) }) }),
  operation({ id: "google.sheets.append", surface: "Sheets", label: "Append row", description: "Append one reviewed JSON row to an A1 range.", effect: "write", risk: "medium", scopes: ["spreadsheets"], inputSchema: object({ spreadsheetId: string(200), range: string(160), rowJson: string(8_000, "JSON array containing one row") }) }),
] as const;

const MICROSOFT_OPERATIONS = [
  operation({ id: "microsoft.outlook.search", surface: "Outlook", label: "List messages", description: "Read a bounded set of recent Outlook messages.", effect: "read", risk: "low", scopes: ["Mail.Read"], inputSchema: object({ search: string(240) }, []) }),
  operation({ id: "microsoft.outlook.agent-team-inbox", surface: "Outlook", label: "Use Agent Team inbox", description: "Read bounded matching requests and post receipt-only replies to the original Outlook message.", effect: "read", risk: "low", scopes: ["Mail.Read", "Mail.Send"], inputSchema: object({ search: string(240) }, []) }),
  operation({ id: "microsoft.outlook.create-draft", surface: "Outlook", label: "Create draft", description: "Create one unsent Outlook message draft.", effect: "write", risk: "medium", scopes: ["Mail.ReadWrite"], inputSchema: object({ to: string(320), subject: string(240), body: string(8_000) }) }),
  operation({ id: "microsoft.calendar.list-events", surface: "Calendar", label: "List events", description: "Read a bounded set of upcoming Microsoft 365 events.", effect: "read", risk: "low", scopes: ["Calendars.Read"], inputSchema: object({ start: string(80), end: string(80) }) }),
  operation({ id: "microsoft.calendar.create-event", surface: "Calendar", label: "Create event", description: "Create one event on the signed-in user's calendar.", effect: "write", risk: "medium", scopes: ["Calendars.ReadWrite"], inputSchema: object({ subject: string(240), start: string(80), end: string(80), timeZone: string(80) }) }),
  operation({ id: "microsoft.teams.list", surface: "Teams", label: "List joined teams", description: "Read a bounded list of joined Microsoft Teams.", effect: "read", risk: "low", scopes: ["Team.ReadBasic.All"], inputSchema: object({}, []) }),
  operation({ id: "microsoft.teams.list-channels", surface: "Teams", label: "List channels", description: "Read a bounded list of channels from one joined Microsoft Team.", effect: "read", risk: "low", scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All"], inputSchema: object({ teamId: string(160) }) }),
  operation({ id: "microsoft.teams.read-messages", surface: "Teams", label: "Use Agent Team channel", description: "Choose a joined Team and channel, verify message senders, read bounded requests, and post receipt-only status replies.", effect: "read", risk: "low", scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All", "User.ReadBasic.All", "ChannelMessage.Send"], inputSchema: object({ teamId: string(160), channelId: string(200) }) }),
  operation({ id: "microsoft.teams.send-message", surface: "Teams", label: "Send channel message", description: "Send one approved message to a selected team channel.", effect: "write", risk: "medium", scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send"], inputSchema: object({ teamId: string(160), channelId: string(200), body: string(8_000) }) }),
  operation({ id: "microsoft.onedrive.list", surface: "OneDrive", label: "List files", description: "Read a bounded list of root OneDrive items.", effect: "read", risk: "low", scopes: ["Files.Read"], inputSchema: object({}, []) }),
  operation({ id: "microsoft.sharepoint.search", surface: "SharePoint", label: "Search sites", description: "Find a bounded set of SharePoint sites.", effect: "read", risk: "low", scopes: ["Sites.Read.All"], inputSchema: object({ query: string(240) }) }),
] as const;

const PROVIDER_DEFINITIONS: readonly ProviderPackDefinition[] = [
  {
    id: "google-workspace", label: "Google Workspace", group: "work", surfaces: ["Gmail", "Calendar", "Drive", "Docs", "Sheets"], namedUser: "Operations lead", targetJob: "Turn an inbox request into a researched draft, calendar handoff, and updated operating record.", docsUrl: "https://developers.google.com/workspace", credentialFields: bearer("Google OAuth access token", "Grant only the Workspace scopes used by this Agent Team."), connectionFields: none, operations: GOOGLE_OPERATIONS,
    support: { rateLimit: "Google Workspace per-user and per-project quotas apply; 429 and quota errors halt with a retryable receipt.", errors: "Expired or insufficient OAuth scopes block the exact operation and request reconnection.", cost: "Codelit adds no provider markup; Google Workspace API quotas are owned by the user's account." },
  },
  {
    id: "microsoft-365", label: "Microsoft 365", group: "work", surfaces: ["Outlook", "Calendar", "Teams", "OneDrive", "SharePoint"], namedUser: "Program manager", targetJob: "Research a work request, prepare a draft, schedule the handoff, and publish the approved update to Teams.", docsUrl: "https://learn.microsoft.com/graph/", credentialFields: bearer("Microsoft Graph access token", "Grant only the delegated Graph scopes used by this Agent Team."), connectionFields: none, operations: MICROSOFT_OPERATIONS,
    support: { rateLimit: "Microsoft Graph throttling and Retry-After guidance apply; bounded runs stop before broad retry loops.", errors: "Expired tokens, missing delegated scopes, and tenant policy failures remain explicit setup blockers.", cost: "Codelit adds no provider markup; Microsoft licensing and Graph limits remain with the connected tenant." },
  },
  {
    id: "zendesk", label: "Zendesk", group: "support", surfaces: ["Support"], namedUser: "Support lead", targetJob: "Find a customer ticket, prepare a grounded resolution, and add the approved comment or status update.", docsUrl: "https://developer.zendesk.com/api-reference/ticketing/", credentialFields: bearer("Zendesk OAuth token"), connectionFields: [{ key: "subdomain", label: "Subdomain", placeholder: "acme", kind: "slug", required: true }], operations: [
      operation({ id: "zendesk.tickets.search", surface: "Support", label: "Search tickets", description: "Search up to ten agent-visible tickets.", effect: "read", risk: "low", scopes: ["tickets:read"], inputSchema: object({ query: string(500) }) }),
      operation({ id: "zendesk.tickets.update", surface: "Support", label: "Update ticket", description: "Add one comment and optional explicit ticket status.", effect: "write", risk: "medium", scopes: ["tickets:write"], inputSchema: object({ ticketId: string(40), comment: string(8_000), status: string(20, undefined, ["open", "pending", "hold", "solved"]) }, ["ticketId", "comment"]) }),
    ], support: { rateLimit: "Zendesk account and ticket-update limits apply; 429 is surfaced with bounded retry guidance.", errors: "Restricted-agent visibility, collisions, and invalid status transitions halt without widening scope.", cost: "Uses the customer's Zendesk plan and token; Codelit adds no per-call provider fee." },
  },
  {
    id: "intercom", label: "Intercom", group: "support", surfaces: ["Inbox"], namedUser: "Customer success manager", targetJob: "Find a conversation and post one approved admin reply with a durable receipt.", docsUrl: "https://developers.intercom.com/docs/references/rest-api/", credentialFields: bearer("Intercom access token"), connectionFields: [{ key: "adminId", label: "Admin ID", placeholder: "123456", kind: "slug", required: true }], operations: [
      operation({ id: "intercom.conversations.search", surface: "Inbox", label: "Search conversations", description: "Find up to ten conversations by source text.", effect: "read", risk: "low", scopes: ["conversations:read"], inputSchema: object({ query: string(240) }) }),
      operation({ id: "intercom.conversations.reply", surface: "Inbox", label: "Reply to conversation", description: "Post one approved admin reply to a conversation.", effect: "write", risk: "medium", scopes: ["conversations:write"], inputSchema: object({ conversationId: string(120), body: string(8_000) }) }),
    ], support: { rateLimit: "Intercom workspace rate limits apply; 429 responses stop the action with no duplicate reply.", errors: "Unavailable conversations, missing admin identity, and subscription restrictions remain explicit failures.", cost: "Uses the customer's Intercom subscription; Codelit adds no provider-call fee." },
  },
  {
    id: "stripe", label: "Stripe", group: "support", surfaces: ["Payments"], namedUser: "Billing support lead", targetJob: "Verify a payment, compare it with policy, and issue one approved full or partial refund.", docsUrl: "https://docs.stripe.com/api", credentialFields: bearer("Restricted Stripe key", "Use a restricted key limited to PaymentIntents read and Refunds write."), connectionFields: none, operations: [
      operation({ id: "stripe.payment-intents.retrieve", surface: "Payments", label: "Retrieve payment", description: "Read one PaymentIntent and its current refund state.", effect: "read", risk: "medium", scopes: ["payment_intents:read"], inputSchema: object({ paymentIntentId: string(160) }) }),
      operation({ id: "stripe.refunds.create", surface: "Payments", label: "Create refund", description: "Create one exact refund at or below the run's approved ceiling.", effect: "write", risk: "high", scopes: ["refunds:write"], inputSchema: object({ paymentIntentId: string(160), amount: string(20, "Exact amount in the smallest currency unit"), maximumAmount: string(20, "Approved maximum in the smallest currency unit"), reason: string(30, undefined, ["duplicate", "fraudulent", "requested_by_customer"]) }, ["paymentIntentId", "reason"]) }),
    ], support: { rateLimit: "Stripe API limits and idempotency semantics apply; the same approved action key is reused on retry.", errors: "Insufficient refundable amount, invalid state, and restricted-key failures halt before any alternate payment action.", cost: "Stripe refund and payment fees remain governed by the connected Stripe account; Codelit adds no markup." },
  },
  {
    id: "shopify", label: "Shopify", group: "support", surfaces: ["Orders"], namedUser: "Commerce support lead", targetJob: "Inspect an order and apply one approved operational tag for fulfillment or resolution follow-up.", docsUrl: "https://shopify.dev/docs/api/admin-graphql", credentialFields: bearer("Shopify Admin access token"), connectionFields: [{ key: "shop", label: "Shop", placeholder: "acme", kind: "slug", required: true }], operations: [
      operation({ id: "shopify.orders.lookup", surface: "Orders", label: "Look up order", description: "Read one order by Shopify GID.", effect: "read", risk: "medium", scopes: ["read_orders"], inputSchema: object({ orderId: string(200) }) }),
      operation({ id: "shopify.orders.add-tags", surface: "Orders", label: "Add order tags", description: "Add up to five reviewed tags to one order.", effect: "write", risk: "medium", scopes: ["write_orders"], inputSchema: object({ orderId: string(200), tags: string(500, "Comma-separated tags") }) }),
    ], support: { rateLimit: "Shopify GraphQL calculated-query limits apply; throttle responses halt without changing the mutation.", errors: "GraphQL userErrors are treated as failed actions and preserved as bounded evidence.", cost: "Uses the merchant's Shopify Admin API allocation; Codelit adds no provider-call fee." },
  },
  {
    id: "hubspot", label: "HubSpot", group: "revenue", surfaces: ["CRM"], namedUser: "Revenue operations manager", targetJob: "Review a contact and move its lead status only after the evidence and owner approval are present.", docsUrl: "https://developers.hubspot.com/docs/api-reference/crm", credentialFields: bearer("HubSpot private app token"), connectionFields: none, operations: [
      operation({ id: "hubspot.contacts.retrieve", surface: "CRM", label: "Retrieve contact", description: "Read one contact with a fixed property allowlist.", effect: "read", risk: "low", scopes: ["crm.objects.contacts.read"], inputSchema: object({ contactId: string(120) }) }),
      operation({ id: "hubspot.contacts.set-lead-status", surface: "CRM", label: "Set lead status", description: "Set one contact to an explicit HubSpot lead status.", effect: "write", risk: "medium", scopes: ["crm.objects.contacts.write"], inputSchema: object({ contactId: string(120), status: string(40, undefined, ["NEW", "OPEN", "IN_PROGRESS", "OPEN_DEAL", "UNQUALIFIED", "ATTEMPTED_TO_CONTACT", "CONNECTED", "BAD_TIMING"]) }) }),
    ], support: { rateLimit: "HubSpot app and account limits apply; 429 responses remain retryable without a second write checkpoint.", errors: "Missing scopes, archived contacts, and invalid status values halt the operation exactly.", cost: "Uses the customer's HubSpot account and private app allocation; no Codelit provider markup." },
  },
  {
    id: "salesforce", label: "Salesforce", group: "revenue", surfaces: ["CRM"], namedUser: "Sales operations manager", targetJob: "Review a lead and create one approved follow-up task without broad SOQL or field access.", docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/", credentialFields: bearer("Salesforce OAuth access token"), connectionFields: [{ key: "instanceHost", label: "Instance host", placeholder: "acme.my.salesforce.com", kind: "hostname", required: true }], operations: [
      operation({ id: "salesforce.leads.retrieve", surface: "CRM", label: "Retrieve lead", description: "Read one Lead through a fixed field allowlist.", effect: "read", risk: "low", scopes: ["api"], inputSchema: object({ leadId: string(40) }) }),
      operation({ id: "salesforce.tasks.create", surface: "CRM", label: "Create follow-up task", description: "Create one bounded Task associated with a reviewed lead.", effect: "write", risk: "medium", scopes: ["api"], inputSchema: object({ leadId: string(40), subject: string(240), description: string(8_000) }) }),
    ], support: { rateLimit: "Salesforce org API limits apply and are exposed as bounded provider failures.", errors: "Invalid instance hosts, object IDs, permissions, and validation rules halt without alternate object access.", cost: "Uses the connected Salesforce org's API entitlement; Codelit adds no provider-call fee." },
  },
  {
    id: "sentry", label: "Sentry", group: "engineering", surfaces: ["Issues"], namedUser: "On-call engineer", targetJob: "Read the highest-impact issues and apply one approved status change after diagnosis.", docsUrl: "https://docs.sentry.io/api/events/", credentialFields: bearer("Sentry auth token"), connectionFields: [{ key: "organization", label: "Organization slug", placeholder: "acme", kind: "slug", required: true }], operations: [
      operation({ id: "sentry.issues.list", surface: "Issues", label: "List issues", description: "Read up to ten organization issues matching a Sentry query.", effect: "read", risk: "low", scopes: ["event:read"], inputSchema: object({ query: string(500) }, []) }),
      operation({ id: "sentry.issues.update-status", surface: "Issues", label: "Update issue status", description: "Set one issue to an explicit reviewed status.", effect: "write", risk: "medium", scopes: ["event:write"], inputSchema: object({ issueId: string(80), status: string(40, undefined, ["resolved", "unresolved", "ignored"]) }) }),
    ], support: { rateLimit: "Sentry organization rate limits apply; retries never widen the issue query or status.", errors: "Missing event scopes, unknown issues, and unsupported status details halt explicitly.", cost: "Uses the customer's Sentry plan and API allocation; no Codelit provider markup." },
  },
  {
    id: "posthog", label: "PostHog", group: "engineering", surfaces: ["Product analytics"], namedUser: "Product engineer", targetJob: "Review saved insights and attach one approved operational annotation to the product timeline.", docsUrl: "https://posthog.com/docs/api", credentialFields: bearer("PostHog personal API key"), connectionFields: [{ key: "region", label: "Cloud region", placeholder: "US", kind: "choice", required: true, choices: [{ value: "us", label: "US Cloud" }, { value: "eu", label: "EU Cloud" }] }, { key: "projectId", label: "Project ID", placeholder: "12345", kind: "slug", required: true }], operations: [
      operation({ id: "posthog.insights.list", surface: "Product analytics", label: "List insights", description: "Read a bounded list of saved insights.", effect: "read", risk: "low", scopes: ["insight:read"], inputSchema: object({ search: string(240) }, []) }),
      operation({ id: "posthog.annotations.create", surface: "Product analytics", label: "Create annotation", description: "Create one bounded product timeline annotation.", effect: "write", risk: "medium", scopes: ["annotation:write"], inputSchema: object({ content: string(2_000), date: string(80), scope: string(20, undefined, ["project", "organization"]) }) }),
    ], support: { rateLimit: "PostHog API key and project rate limits apply; 429 responses halt with retry guidance.", errors: "Wrong region, project ownership, or key scopes block the exact operation.", cost: "Uses the connected PostHog project's API; Codelit adds no provider-call fee." },
  },
  {
    id: "datadog", label: "Datadog", group: "engineering", surfaces: ["Observability"], namedUser: "Site reliability engineer", targetJob: "Review active monitors and post one approved incident event to the operational timeline.", docsUrl: "https://docs.datadoghq.com/api/latest/", credentialFields: [{ key: "apiKey", label: "API key", placeholder: "Datadog API key", hint: "Use an API key from the intended organization." }, { key: "appKey", label: "Application key", placeholder: "Scoped application key", hint: "Use a user or service-account application key with monitor read and event write permissions." }], connectionFields: [{ key: "site", label: "Datadog site", placeholder: "US1", kind: "choice", required: true, choices: [{ value: "datadoghq.com", label: "US1" }, { value: "us3.datadoghq.com", label: "US3" }, { value: "us5.datadoghq.com", label: "US5" }, { value: "datadoghq.eu", label: "EU" }, { value: "ap1.datadoghq.com", label: "AP1" }, { value: "ap2.datadoghq.com", label: "AP2" }] }], operations: [
      operation({ id: "datadog.monitors.list", surface: "Observability", label: "List monitors", description: "Read a bounded list of alerting monitors.", effect: "read", risk: "low", scopes: ["monitors_read"], inputSchema: object({ groupStates: string(120) }, []) }),
      operation({ id: "datadog.events.create", surface: "Observability", label: "Create event", description: "Post one bounded event to the Events Explorer.", effect: "write", risk: "medium", scopes: ["events_write"], inputSchema: object({ title: string(240), text: string(4_000), tags: string(500) }, ["title", "text"]) }),
    ], support: { rateLimit: "Datadog endpoint limits and response headers apply; bounded retries respect 429 classification.", errors: "API/app-key organization mismatch and missing permissions block the operation without fallback.", cost: "Uses the connected Datadog plan and event allocation; Codelit adds no provider-call fee." },
  },
  {
    id: "pagerduty", label: "PagerDuty", group: "engineering", surfaces: ["Incidents"], namedUser: "Incident commander", targetJob: "Review active incidents and acknowledge one selected incident after ownership is clear.", docsUrl: "https://developer.pagerduty.com/api-reference/", credentialFields: bearer("PagerDuty API token"), connectionFields: [{ key: "fromEmail", label: "Requester email", placeholder: "oncall@example.com", kind: "email", required: true }], operations: [
      operation({ id: "pagerduty.incidents.list", surface: "Incidents", label: "List incidents", description: "Read a bounded list of triggered and acknowledged incidents.", effect: "read", risk: "low", scopes: ["incidents.read"], inputSchema: object({ serviceId: string(120) }, []) }),
      operation({ id: "pagerduty.incidents.acknowledge", surface: "Incidents", label: "Acknowledge incident", description: "Acknowledge one reviewed incident as the connected user.", effect: "write", risk: "high", scopes: ["incidents.write"], inputSchema: object({ incidentId: string(160) }) }),
    ], support: { rateLimit: "PagerDuty REST API limits apply; rate-limit responses halt without changing incident state twice.", errors: "Resolved incidents, invalid requester identity, and insufficient incident permissions remain explicit.", cost: "Uses the customer's PagerDuty plan and API entitlement; Codelit adds no provider-call fee." },
  },
  {
    id: "supabase", label: "Supabase / Postgres", group: "engineering", surfaces: ["Data API"], namedUser: "Data operations engineer", targetJob: "Read an RLS-scoped table and insert one schema-reviewed operational record.", docsUrl: "https://supabase.com/docs/guides/api", credentialFields: bearer("Publishable or anon key", "Service-role and sb_secret keys are rejected; use Row Level Security to bound access."), connectionFields: [{ key: "projectRef", label: "Project ref", placeholder: "abcdefghijklmnopqrst", kind: "slug", required: true }], operations: [
      operation({ id: "supabase.rows.list", surface: "Data API", label: "List rows", description: "Read up to ten rows and an explicit column list from one RLS-scoped table.", effect: "read", risk: "medium", scopes: ["RLS read"], inputSchema: object({ table: string(80), columns: string(500), filter: string(500) }, ["table", "columns"]) }),
      operation({ id: "supabase.rows.insert", surface: "Data API", label: "Insert row", description: "Insert one bounded reviewed JSON object through Row Level Security.", effect: "write", risk: "high", scopes: ["RLS insert"], inputSchema: object({ table: string(80), rowJson: string(8_000) }) }),
    ], support: { rateLimit: "Supabase project gateway and PostgREST limits apply; responses are capped before reaching the model.", errors: "RLS denial, schema mismatch, elevated secret keys, and invalid table identifiers fail closed.", cost: "Uses the customer's Supabase project and database allocation; Codelit adds no provider-call fee." },
  },
] as const;

export const PROVIDER_PACKS = Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<ProviderPackId, ProviderPackDefinition>;

const PROVIDER_ID_SET = new Set<string>(PROVIDER_PACK_IDS);
const OPERATION_BY_ID = new Map<string, ProviderPackOperation>(
  PROVIDER_DEFINITIONS.flatMap((provider) => provider.operations.map((item) => [item.id, item] as const)),
);

export function isProviderPackId(value: unknown): value is ProviderPackId {
  return typeof value === "string" && PROVIDER_ID_SET.has(value);
}

export function providerPackOperation(id: unknown) {
  return typeof id === "string" ? OPERATION_BY_ID.get(id) || null : null;
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function sanitizeSetting(field: ProviderConnectionField, value: unknown) {
  const text = cleanText(value, field.kind === "email" || field.kind === "hostname" ? 253 : 160);
  if (!text) return field.required ? null : "";
  if (field.kind === "email") return EMAIL.test(text) ? text.toLowerCase() : null;
  if (field.kind === "slug") return SLUG.test(text) ? text : null;
  if (field.kind === "hostname") return HOSTNAME.test(text.toLowerCase()) ? text.toLowerCase() : null;
  if (field.kind === "choice") return field.choices?.some((choice) => choice.value === text) ? text : null;
  return text;
}

export function sanitizeProviderConnectionDraft(value: unknown): { ok: true; draft: ProviderConnectionDraft } | { ok: false; reason: string } {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw || !isProviderPackId(raw.providerId)) return { ok: false, reason: "Choose a supported provider account" };
  const provider = PROVIDER_PACKS[raw.providerId];
  const rawCredentials = raw.credentials && typeof raw.credentials === "object" && !Array.isArray(raw.credentials) ? raw.credentials as Record<string, unknown> : {};
  const credentials: Partial<Record<ProviderCredentialKey, string>> = {};
  for (const field of provider.credentialFields) {
    const rawCredential = rawCredentials[field.key];
    const credential = typeof rawCredential === "string" ? rawCredential.trim().slice(0, 8_192) : "";
    if (!credential) return { ok: false, reason: `${field.label} is required` };
    credentials[field.key] = credential;
  }
  if (raw.providerId === "supabase") {
    const token = credentials.token || "";
    if (token.startsWith("sb_secret_") || /"role"\s*:\s*"service_role"/.test(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"))) {
      return { ok: false, reason: "Use a publishable or anon key protected by Row Level Security, never a service-role secret" };
    }
  }
  const rawSettings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? raw.settings as Record<string, unknown> : {};
  const settings: Record<string, string> = {};
  for (const field of provider.connectionFields) {
    const setting = sanitizeSetting(field, rawSettings[field.key]);
    if (setting === null) return { ok: false, reason: `${field.label} is invalid` };
    if (setting) settings[field.key] = setting;
  }
  if (raw.providerId === "salesforce" && !/\.(?:my\.)?salesforce\.com$/.test(settings.instanceHost || "")) {
    return { ok: false, reason: "Salesforce instance host must end in salesforce.com" };
  }
  const label = cleanText(raw.label, 100) || provider.label;
  const expiresAt = typeof raw.expiresAt === "string" && Number.isFinite(Date.parse(raw.expiresAt)) ? new Date(raw.expiresAt).toISOString() : undefined;
  return { ok: true, draft: { providerId: raw.providerId, label, credentials, settings, ...(expiresAt ? { expiresAt } : {}) } };
}

function sanitizeInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_INPUT_BYTES ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function materializeTemplateValues(value: unknown, schema: ReviewedJsonSchema): unknown {
  if (typeof value === "string" && HANDOFF_VALUE.test(value)) {
    if (schema.type !== "string") return value;
    return schema.enum?.[0] ?? "";
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      properties[key] ? materializeTemplateValues(child, properties[key]) : child,
    ]));
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((child) => materializeTemplateValues(child, schema.items || { type: "string" }));
  }
  return value;
}

export function sanitizeProviderOperationConfig(value: unknown): ProviderOperationConfig | null {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const providerId = raw?.providerId;
  const operationId = cleanText(raw?.operationId, 128);
  const operation = providerPackOperation(operationId);
  const connectionId = cleanText(raw?.connectionId, 160);
  const input = sanitizeInput(raw?.input || {});
  if (!raw || !isProviderPackId(providerId) || !operation || !OPERATION_ID.test(operationId) || !CONNECTION_ID.test(connectionId) || !input) return null;
  if (!PROVIDER_PACKS[providerId].operations.some((candidate) => candidate.id === operation.id)) return null;
  if (validateReviewedJson(materializeTemplateValues(input, operation.inputSchema), operation.inputSchema).length) return null;
  const connectionLabel = cleanText(raw.connectionLabel, 100);
  if (!connectionLabel) return null;
  const provider = PROVIDER_PACKS[providerId];
  return {
    providerId,
    connectionId,
    operationId,
    connectionLabel,
    providerLabel: provider.label,
    operationLabel: operation.label,
    surface: operation.surface,
    effect: operation.effect,
    risk: operation.risk,
    input,
  };
}

export function renderProviderOperationInput(input: Record<string, unknown>, handoff: string) {
  return renderCustomActionInput(input, handoff);
}

export function canonicalProviderOperationConfig(
  connection: Pick<PublicProviderConnection, "id" | "providerId" | "label">,
  config: ProviderOperationConfig,
): ProviderOperationConfig {
  return {
    ...config,
    connectionLabel: connection.label,
    providerLabel: PROVIDER_PACKS[connection.providerId].label,
  };
}

export function bindProviderTemplateConnections(
  workflow: AgentWorkflow,
  connections: readonly PublicProviderConnection[],
  operationReady: (connection: PublicProviderConnection, operationId: string) => boolean = () => true,
): AgentWorkflow {
  let changed = false;
  const tools = workflow.tools.map((tool) => {
    const config = sanitizeProviderOperationConfig(tool.executionConfig?.providerOperation);
    if (!config?.connectionId.startsWith("provider-template-")) return tool;
    const matches = connections.filter((connection) => (
      connection.providerId === config.providerId
      && connection.status === "ready"
      && operationReady(connection, config.operationId)
    ));
    if (matches.length !== 1) return tool;
    const connection = matches[0];
    changed = true;
    return {
      ...tool,
      executionConfig: {
        ...tool.executionConfig,
        providerOperation: canonicalProviderOperationConfig(connection, { ...config, connectionId: connection.id }),
      },
    };
  });
  return changed ? { ...workflow, tools } : workflow;
}

export function providerOperationPreview(config: ProviderOperationConfig) {
  const input = JSON.stringify(config.input);
  return [
    `${config.effect === "read" ? "Read with" : "Run"} ${config.providerLabel} / ${config.surface} / ${config.operationLabel}`,
    `Connection: ${config.connectionLabel}`,
    `Input: ${input.length > 2_000 ? `${input.slice(0, 2_000)}...` : input}`,
  ];
}

export function defaultProviderOperationInput(operation: ProviderPackOperation) {
  const schema = sanitizeReviewedJsonSchema(operation.inputSchema);
  if (!schema || schema.type !== "object") return {};
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => required.has(key)).map(([key, property]) => {
    if (property.enum?.length) return [key, property.enum[0]];
    if (property.type === "boolean") return [key, false];
    if (property.type === "number" || property.type === "integer") return [key, 0];
    if (property.type === "array") return [key, []];
    if (property.type === "object") return [key, {}];
    return [key, property.description?.includes("Optional") ? "" : "{{handoff}}"];
  }));
}

export function providerPackAdmissionErrors() {
  const errors: string[] = [];
  const operationIds = PROVIDER_DEFINITIONS.flatMap((provider) => provider.operations.map((item) => item.id));
  for (const provider of PROVIDER_DEFINITIONS) {
    if (!provider.namedUser || !provider.targetJob) errors.push(`${provider.id}: missing named user or target job`);
    if (!provider.operations.some((item) => item.effect === "read")) errors.push(`${provider.id}: missing read operation`);
    if (!provider.operations.some((item) => item.effect === "write")) errors.push(`${provider.id}: missing valuable bounded action`);
    if (!provider.docsUrl.startsWith("https://")) errors.push(`${provider.id}: missing provider documentation`);
    if (!provider.support.rateLimit || !provider.support.errors || !provider.support.cost) errors.push(`${provider.id}: missing support behavior`);
    for (const item of provider.operations) {
      if (!OPERATION_ID.test(item.id)) errors.push(`${provider.id}/${item.id}: invalid operation id`);
      if (item.effect === "write" && (item.idempotency !== "required" || item.risk === "low")) errors.push(`${provider.id}/${item.id}: unsafe write contract`);
      if (item.effect === "read" && item.idempotency !== "read-only") errors.push(`${provider.id}/${item.id}: invalid read contract`);
      if (!sanitizeReviewedJsonSchema(item.inputSchema)) errors.push(`${provider.id}/${item.id}: invalid input schema`);
    }
  }
  if (new Set(operationIds).size !== operationIds.length) errors.push("Provider operation IDs collide");
  return errors;
}
