import { describe, it, expect } from 'vitest';
import { buildViewUrl } from '../../src/tableau/authoring/index.js';

describe('buildViewUrl (view-only hash URL)', () => {
  const serverUrl = 'https://prod-in-a.online.tableau.com';
  const siteContentUrl = 'ahingane-2010f153ff';

  it('builds the interactive #/site/.../views/<wb>/<sheet> URL from a view contentUrl', () => {
    const url = buildViewUrl({
      serverUrl,
      siteContentUrl,
      view: { id: 'v1', name: 'SalesAnalysis', contentUrl: 'test7/sheets/SalesAnalysis' },
    });
    expect(url).toBe(
      'https://prod-in-a.online.tableau.com/#/site/ahingane-2010f153ff/views/test7/SalesAnalysis?:embed=yes&:toolbar=no',
    );
  });

  it('falls back to the workbook webpageUrl (recovering the views path)', () => {
    const url = buildViewUrl({
      serverUrl,
      siteContentUrl,
      workbook: {
        id: 'w1',
        name: 'test7',
        webpageUrl: 'https://prod-in-a.online.tableau.com/#/site/ahingane-2010f153ff/views/test7/SalesAnalysis',
      },
    });
    expect(url).toBe(
      'https://prod-in-a.online.tableau.com/#/site/ahingane-2010f153ff/views/test7/SalesAnalysis?:embed=yes&:toolbar=no',
    );
  });

  it('returns undefined when neither a view nor a recoverable workbook URL is present', () => {
    expect(buildViewUrl({ serverUrl, siteContentUrl })).toBeUndefined();
  });
});
