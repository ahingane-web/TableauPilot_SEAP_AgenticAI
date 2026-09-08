import { z } from 'zod';

/**
 * Publishing target. The `projectId`/`siteId` here MUST match the user-approved
 * project context; the publishing guard enforces this before any upload.
 */
export const PublishingSpecSchema = z.object({
  siteId: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  workbookName: z.string().min(1),
  /** If true, an existing workbook of the same name may be overwritten (requires approval). */
  overwrite: z.boolean().default(false),
  showTabs: z.boolean().default(true),
  mode: z.enum(['new_workbook', 'existing_workbook']).default('new_workbook'),
  /** Present only in existing_workbook mode. */
  existingWorkbookId: z.string().optional(),
});
export type PublishingSpec = z.infer<typeof PublishingSpecSchema>;
