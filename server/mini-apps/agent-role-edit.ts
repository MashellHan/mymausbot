import { z } from "zod";

import { LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES, type LocalAgentRoleDocumentTarget,
  type LocalAgentRoleDocumentWrite } from "../../shared/local-dashboard.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import type { RouteContext } from "../routes/table.ts";
import type { MiniAppActor, MiniApps } from "./registry.ts";
import { appFailure } from "./validation.ts";

const target = z.strictObject({
  agentId: z.string().regex(/^w\d+:p[0-9A-Za-z]+$/).max(64),
  occupantId: z.string().regex(/^o[0-9a-f]{16}$/),
  expectedRevision: z.number().int().positive(),
});
const save = target.extend({
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  documentId: z.string().regex(/^[0-9a-f]{64}$/),
  text: z.string().refine((text) => Buffer.byteLength(text) <= LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES
    && Buffer.from(text).toString("utf8") === text && !text.includes("\0")),
});

export async function agentRoleEdit(ctx: RouteContext, id: string, owner: MiniAppActor, apps: Pick<MiniApps, "document">,
  configuration: LocalDashboardProviders["configuration"] | undefined) {
  const { method, req, res, json, readBody } = ctx;
  if (!configuration?.getRoleDocument || !configuration.saveRoleDocument) throw appFailure(503, "Agent MD editing is unavailable.");
  if (method !== "POST" && method !== "PUT") throw appFailure(405, "Method not allowed.");
  const body: unknown = await readBody(req, method === "PUT" ? 6 * LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES + 1024 : 512);
  const parsed = (method === "PUT" ? save : target).safeParse(body);
  if (!parsed.success) throw appFailure(400, "Invalid Agent MD request.");
  const { expectedRevision, ...selection } = parsed.data;
  const assertCurrent = () => {
    owner.assertActive?.();
    const { app } = apps.document(owner, id);
    if (app.revision !== expectedRevision || app.status !== "active") throw appFailure(409, "This Mini App changed. Reopen Agent MD.");
    if (app.dashboardIdentity !== "agent-team" || app.release?.packageId !== "mashellhan.agent-team"
        || app.dashboard?.kind !== "agent-team" || app.dashboard.renderer !== "html"
        || !(app.dashboard.resources as readonly string[]).includes("configuration")) throw appFailure(403, "Agent MD editing is unavailable.");
  };
  assertCurrent();
  if (method === "POST") {
    const doc = await configuration.getRoleDocument(selection as LocalAgentRoleDocumentTarget);
    assertCurrent();
    if (!doc) throw appFailure(409, "The current Agent MD could not be verified.");
    return json(res, 200, doc);
  }
  const result = await configuration.saveRoleDocument(selection as LocalAgentRoleDocumentWrite, assertCurrent);
  if (result.status === "unavailable") throw appFailure(409, "The Agent MD could not be saved. Reopen it and try again.");
  if (result.status === "conflict") return json(res, 409, {
    code: "conflict", error: "The Agent MD changed since you opened it.", current: result.doc.text, currentHash: result.doc.hash,
  });
  return json(res, 200, result.doc);
}
