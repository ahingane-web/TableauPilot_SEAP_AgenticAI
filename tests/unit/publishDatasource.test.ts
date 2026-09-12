import { describe, it, expect, vi } from 'vitest';
import { publishDatasource } from '../../src/tableau/publishing/datasource.js';
import type { TableauClient } from '../../src/tableau/tableauClient.js';
import type { MultipartPart } from '../../src/tableau/tableauClient.js';

function fakeClient(capture: { path?: string; parts?: MultipartPart[] }, response: unknown): TableauClient {
  return {
    postMultipart: vi.fn(async (path: string, parts: MultipartPart[]) => {
      capture.path = path;
      capture.parts = parts;
      return response;
    }),
  } as unknown as TableauClient;
}

describe('publishDatasource', () => {
  it('posts request_payload + .tds file and returns the created datasource', async () => {
    const capture: { path?: string; parts?: MultipartPart[] } = {};
    const client = fakeClient(capture, {
      datasource: { id: 'ds-1', name: 'Salesforce Account DS', contentUrl: 'SalesforceAccountDS', project: { id: 'p1', name: 'Folder' } },
    });

    const result = await publishDatasource(client, {
      siteId: 'site-1',
      projectId: 'p1',
      datasourceName: 'Salesforce Account DS',
      tdsXml: "<?xml version='1.0'?><datasource/>",
      overwrite: true,
      connectionCredentials: { name: 'user@example.com', password: 'secret', embed: true },
    });

    expect(result).toEqual({
      id: 'ds-1',
      name: 'Salesforce Account DS',
      contentUrl: 'SalesforceAccountDS',
      projectId: 'p1',
      projectName: 'Folder',
    });

    expect(capture.path).toBe('/sites/site-1/datasources?overwrite=true');
    const payload = capture.parts?.find((p) => p.name === 'request_payload')?.body as string;
    expect(payload).toContain("<datasource name='Salesforce Account DS'>");
    expect(payload).toContain("<project id='p1' />");
    expect(payload).toContain("<connectionCredentials name='user@example.com' password='secret' embed='true' />");

    const file = capture.parts?.find((p) => p.name === 'tableau_datasource');
    expect(file?.filename).toBe('Salesforce Account DS.tds');
  });

  it('supports OAuth connection credentials', async () => {
    const capture: { path?: string; parts?: MultipartPart[] } = {};
    const client = fakeClient(capture, { datasource: { id: 'ds-2', name: 'X' } });
    await publishDatasource(client, {
      siteId: 's',
      projectId: 'p',
      datasourceName: 'X',
      tdsXml: '<datasource/>',
      connectionCredentials: { oAuth: true, name: 'user@example.com', embed: true },
    });
    const payload = capture.parts?.find((p) => p.name === 'request_payload')?.body as string;
    expect(payload).toContain("<connectionCredentials name='user@example.com' oAuth='true' embed='true' />");
  });

  it('throws when Tableau does not return a datasource id', async () => {
    const client = fakeClient({}, { datasource: {} });
    await expect(
      publishDatasource(client, { siteId: 's', projectId: 'p', datasourceName: 'X', tdsXml: '<x/>' }),
    ).rejects.toThrow(/did not return a datasource id/);
  });
});
