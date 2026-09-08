/**
 * Tableau Cloud domain types (subset used by the app). These mirror the shapes the
 * REST + Metadata APIs return; nothing here is fabricated — every value originates
 * from a live Tableau Cloud response.
 */
import type { FieldRole } from '../schemas/common.js';

export interface TableauSite {
  id: string;
  name: string;
  contentUrl: string;
}

export interface TableauProject {
  id: string;
  name: string;
  description?: string;
  parentProjectId?: string;
}

export interface TableauWorkbook {
  id: string;
  name: string;
  contentUrl?: string;
  webpageUrl?: string;
  projectId?: string;
  projectName?: string;
  ownerId?: string;
  updatedAt?: string;
}

export interface TableauView {
  id: string;
  name: string;
  contentUrl?: string;
  workbookId?: string;
  viewUrlName?: string;
}

export interface TableauDatasource {
  id: string;
  name: string;
  contentUrl?: string;
  projectId?: string;
  projectName?: string;
  type?: string;
  isCertified?: boolean;
  updatedAt?: string;
}

/** A field discovered from a published datasource via the Metadata API. */
export interface DatasourceField {
  name: string;
  role: FieldRole;
  /** Tableau logical data type, e.g. INTEGER, REAL, STRING, DATE, DATETIME, BOOLEAN. */
  dataType: string;
  /** True when the field is a date/datetime type. */
  isDate: boolean;
  /** __typename from the Metadata API (ColumnField, CalculatedField, …). */
  fieldType?: string;
}

export interface DatasourceMetadata {
  datasourceId: string;
  datasourceName: string;
  fields: DatasourceField[];
  dimensions: DatasourceField[];
  measures: DatasourceField[];
  dates: DatasourceField[];
  /** True when metadata came from the Metadata API; false if it was unavailable. */
  metadataApiAvailable: boolean;
}

/** A single capability grant evaluated for the current user. */
export interface CapabilityCheck {
  name: string;
  allowed: boolean;
}

export interface PermissionResult {
  /** Overall decision for the requested action. */
  allowed: boolean;
  /** Human-readable reason (safe to show the user). */
  reason: string;
  capabilities: CapabilityCheck[];
  /** True when we could not conclusively determine permissions from the API. */
  indeterminate: boolean;
}

export interface PublishResult {
  workbookId: string;
  name: string;
  contentUrl?: string;
  webpageUrl?: string;
  projectId?: string;
  projectName?: string;
}

export interface WorkbookVerification {
  exists: boolean;
  workbookId: string;
  name: string;
  siteId: string;
  projectId?: string;
  projectName?: string;
  contentUrl?: string;
  webpageUrl?: string;
  views: TableauView[];
  /** The resolved, real Tableau Cloud URL to open the workbook/dashboard. */
  url?: string;
  connectedDatasourceIds: string[];
}
