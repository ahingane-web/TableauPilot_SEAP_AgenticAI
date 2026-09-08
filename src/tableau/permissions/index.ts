/**
 * Permission validation.
 *
 * Before any authoring/publishing we check the user's Tableau permissions. These
 * checks are advisory-but-honest: Tableau Cloud remains the true enforcement point
 * (it rejects unauthorized publishes server-side), but we surface what we can
 * determine so the app can stop early with a clear message instead of failing late.
 *
 *  - Explicit "Deny" for the current user  -> blocked.
 *  - Explicit "Allow"                       -> allowed.
 *  - No explicit grant (e.g. group-based)   -> allowed but marked indeterminate.
 */
import type { TableauClient } from '../tableauClient.js';
import type { CapabilityCheck, PermissionResult } from '../types.js';

interface Capability {
  name: string;
  mode: string; // 'Allow' | 'Deny'
}
interface GranteeCapabilities {
  user?: { id?: string };
  group?: { id?: string };
  capabilities?: { capability?: Capability | Capability[] };
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchGrantees(client: TableauClient, path: string): Promise<GranteeCapabilities[]> {
  const body = await client.get<any>(path);
  return toArray<GranteeCapabilities>(body?.permissions?.granteeCapabilities);
}

/** Evaluate acceptable capability names for a specific user. */
function evaluate(
  grantees: GranteeCapabilities[],
  userId: string,
  acceptable: string[],
): { explicitAllow: boolean; explicitDeny: boolean; checks: CapabilityCheck[] } {
  let explicitAllow = false;
  let explicitDeny = false;
  const checks: CapabilityCheck[] = [];
  for (const g of grantees) {
    if (g.user?.id !== userId) continue;
    for (const cap of toArray(g.capabilities?.capability)) {
      if (!acceptable.includes(cap.name)) continue;
      const allowed = cap.mode === 'Allow';
      checks.push({ name: cap.name, allowed });
      if (allowed) explicitAllow = true;
      else explicitDeny = true;
    }
  }
  return { explicitAllow, explicitDeny, checks };
}

function decide(
  action: string,
  target: string,
  result: { explicitAllow: boolean; explicitDeny: boolean; checks: CapabilityCheck[] },
): PermissionResult {
  if (result.explicitDeny) {
    return {
      allowed: false,
      reason: `You are explicitly denied permission to ${action} for ${target}.`,
      capabilities: result.checks,
      indeterminate: false,
    };
  }
  if (result.explicitAllow) {
    return {
      allowed: true,
      reason: `You have permission to ${action} for ${target}.`,
      capabilities: result.checks,
      indeterminate: false,
    };
  }
  return {
    allowed: true,
    reason: `No explicit permission grant found for ${action} on ${target}; proceeding, but Tableau Cloud will enforce this on the actual operation.`,
    capabilities: result.checks,
    indeterminate: true,
  };
}

/** Can the user publish workbooks into this project? */
export async function checkProjectPublishPermission(
  client: TableauClient,
  siteId: string,
  projectId: string,
  userId: string,
  projectName: string,
): Promise<PermissionResult> {
  try {
    const grantees = await fetchGrantees(client, `/sites/${siteId}/projects/${projectId}/permissions`);
    return decide('publish', `project "${projectName}"`, evaluate(grantees, userId, ['Write', 'ProjectLeader']));
  } catch {
    return {
      allowed: true,
      reason: `Could not read project permissions; Tableau Cloud will enforce publish rights on upload.`,
      capabilities: [],
      indeterminate: true,
    };
  }
}

/** Can the user read/connect to this datasource? */
export async function checkDatasourceAccess(
  client: TableauClient,
  siteId: string,
  datasourceId: string,
  userId: string,
  datasourceName: string,
): Promise<PermissionResult> {
  try {
    const grantees = await fetchGrantees(client, `/sites/${siteId}/datasources/${datasourceId}/permissions`);
    return decide('use', `datasource "${datasourceName}"`, evaluate(grantees, userId, ['Read', 'Connect']));
  } catch {
    return {
      allowed: true,
      reason: `Could not read datasource permissions; Tableau Cloud will enforce access on use.`,
      capabilities: [],
      indeterminate: true,
    };
  }
}

/** Can the user web-edit (author) this existing workbook? */
export async function checkWorkbookEditPermission(
  client: TableauClient,
  siteId: string,
  workbookId: string,
  userId: string,
  workbookName: string,
): Promise<PermissionResult> {
  try {
    const grantees = await fetchGrantees(client, `/sites/${siteId}/workbooks/${workbookId}/permissions`);
    return decide('web-edit', `workbook "${workbookName}"`, evaluate(grantees, userId, ['Write', 'ViewComments']));
  } catch {
    return {
      allowed: true,
      reason: `Could not read workbook permissions; Tableau Cloud will enforce edit rights on save.`,
      capabilities: [],
      indeterminate: true,
    };
  }
}
