import { describe, it, expect } from 'vitest';
import {
  generateTwb,
  escapeXml,
  parseAlreadyDefinedCalcFields,
  removeCalculatedFields,
} from '../../src/tableau/authoring/twbGenerator.js';
import { makePlan, metadata } from '../fixtures/plan.js';

describe('escapeXml', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  });
});

describe('generateTwb', () => {
  const xml = generateTwb(makePlan(), metadata, { serverHost: 'prod-in-a.online.tableau.com' });

  it('produces a well-formed workbook root', () => {
    expect(xml.startsWith("<?xml version='1.0'")).toBe(true);
    expect(xml).toContain('<workbook version=');
    expect(xml).toContain('</workbook>');
  });

  it('references the published datasource through the data server via sqlproxy', () => {
    // Verified against a real workbook built on a published datasource: the datasource is
    // named sqlproxy.* and connects via a sqlproxy connection to the pod's data-server host.
    expect(xml).toContain("name='sqlproxy.tableaupilot'");
    expect(xml).toContain("class='sqlproxy'");
    expect(xml).toContain("dbname='superstore'");
    expect(xml).toContain("directory='/dataserver'");
    expect(xml).toContain("server='prod-in-a.online.tableau.com'");
    expect(xml).toContain("<relation name='sqlproxy' table='[sqlproxy]' type='table' />");
  });

  it('does NOT emit a repository-location (published ds is reached via sqlproxy)', () => {
    expect(xml).not.toContain('<repository-location');
  });

  it('emits metadata-records for referenced fields with parent-name [sqlproxy]', () => {
    expect(xml).toContain('<metadata-records>');
    expect(xml).toContain('<remote-name>Sales</remote-name>');
    // A measure maps to a real (DBTYPE_R8 == remote-type 5) column.
    expect(xml).toMatch(/<remote-name>Sales<\/remote-name>\s*<remote-type>5<\/remote-type>/);
    expect(xml).toContain('<parent-name>[sqlproxy]</parent-name>');
  });

  it('uses Standard fit (no entire-view zoom) for a detail sheet, but Entire View for charts', () => {
    // Baseline: the default plan's bar chart keeps Entire View.
    expect(xml).toContain("<zoom type='entire-view' />");

    const plan = makePlan();
    plan.dashboardName = 'Contacts';
    plan.worksheets = [
      {
        name: 'Contact Details',
        chartType: 'detail',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.layout = {
      ...plan.layout,
      items: [{ worksheet: 'Contact Details', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }],
    };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The detail sheet's viewpoint omits the entire-view zoom → Standard (scrollable) fit.
    const vpStart = out.indexOf("<viewpoint name='Contact Details'>");
    expect(vpStart).toBeGreaterThan(-1);
    const viewpoint = out.slice(vpStart, out.indexOf('</viewpoint>', vpStart));
    expect(viewpoint).not.toContain("<zoom type='entire-view' />");
  });

  it('honors an explicit per-sheet Fit override (formatting.fit) over the chart-type default', () => {
    const plan = makePlan();
    plan.dashboardName = 'Fit Board';
    plan.worksheets = [
      {
        name: 'Sales Bar',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
        // A bar chart defaults to Entire View, but the user pinned it to Fit Width.
        formatting: { fit: 'fit_width' },
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.layout = {
      ...plan.layout,
      items: [{ worksheet: 'Sales Bar', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }],
    };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    const vpStart = out.indexOf("<viewpoint name='Sales Bar'>");
    const viewpoint = out.slice(vpStart, out.indexOf('</viewpoint>', vpStart));
    expect(viewpoint).toContain("<zoom type='fit-width' />");
    expect(viewpoint).not.toContain("entire-view");
  });

  it('normalizes a boolean dimension filter member to the canonical unquoted true/false', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Important Contacts',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        // Plan supplies a non-canonical boolean value ("Yes"); Tableau only parses true/false.
        filters: [{ field: 'Important', operator: 'in', values: ['Yes'], scope: 'selected_worksheets', worksheets: ['Important Contacts'], showAsControl: false }],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    const meta = {
      ...metadata,
      fields: [
        ...metadata.fields,
        { name: 'Important', role: 'dimension', dataType: 'BOOLEAN', isDate: false, fieldType: 'ColumnField' },
      ],
    } as typeof metadata;
    const out = generateTwb(plan, meta, { serverHost: 'prod-in-a.online.tableau.com' });
    // The boolean member is the unquoted literal `true`, never the raw plan value.
    expect(out).toContain("function='member' level='[none:Important:nk]' member='true'");
    expect(out).not.toContain("member='Yes'");
    expect(out).not.toContain("member='&quot;Yes&quot;'");
  });

  it('coerces a boolean field used as a measure to a real column (Tableau rejects boolean measures)', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Priority Count',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'IsPriorityRecord', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    const meta = {
      ...metadata,
      fields: [
        ...metadata.fields,
        { name: 'IsPriorityRecord', role: 'measure', dataType: 'BOOLEAN', isDate: false, fieldType: 'ColumnField' },
      ],
    } as typeof metadata;
    const out = generateTwb(plan, meta, { serverHost: 'prod-in-a.online.tableau.com' });
    // The datasource column is declared real+measure, never boolean+measure.
    expect(out).toContain(
      "<column caption='IsPriorityRecord' datatype='real' name='[IsPriorityRecord]' role='measure' type='quantitative' />",
    );
    expect(out).not.toContain("datatype='boolean' name='[IsPriorityRecord]' role='measure'");
    // The metadata-record local-type is coerced too (real -> remote-type 5).
    expect(out).toMatch(/<remote-name>IsPriorityRecord<\/remote-name>\s*<remote-type>5<\/remote-type>/);
  });

  it('renders every worksheet from the plan', () => {
    expect(xml).toContain("<worksheet name='Sales by Category'>");
    expect(xml).toContain("<worksheet name='Profit Ratio'>");
  });

  it('emits columns for referenced fields and the calculated field', () => {
    expect(xml).toContain("caption='Category'");
    expect(xml).toContain("caption='Sales'");
    expect(xml).toContain("caption='Profit Ratio'");
    expect(xml).toContain("<calculation class='tableau'");
  });

  it('renders the dashboard with its name and zones', () => {
    expect(xml).toContain("<dashboard name='Sales Overview'>");
    expect(xml).toContain('<zones>');
  });

  it('references fields on shelves via declared column-instances', () => {
    // Dimension instance + shelf reference on cols.
    expect(xml).toContain("<column-instance column='[Category]' derivation='None' name='[none:Category:nk]' pivot='key' type='nominal' />");
    expect(xml).toContain("<cols>[sqlproxy.tableaupilot].[none:Category:nk]</cols>");
    // Measure instance (SUM) + shelf reference on rows.
    expect(xml).toContain("<column-instance column='[Sales]' derivation='Sum' name='[sum:Sales:qk]' pivot='key' type='quantitative' />");
    expect(xml).toContain("<rows>[sqlproxy.tableaupilot].[sum:Sales:qk]</rows>");
    // Aggregation + simple-id markers Tableau expects.
    expect(xml).toContain("<aggregation value='true' />");
    expect(xml).toContain('<simple-id uuid=');
  });

  it('combines multiple measures on one shelf with " + " (never bare concatenation)', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Sales and Profit by Sub-Category',
        chartType: 'bar',
        dimensions: ['Sub-Category'],
        measures: [
          { field: 'Sales', aggregation: 'sum' },
          { field: 'Profit', aggregation: 'sum' },
        ],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    const meta = {
      ...metadata,
      fields: [
        ...metadata.fields,
        { name: 'Sub-Category', role: 'dimension', dataType: 'STRING', isDate: false, fieldType: 'ColumnField' },
      ],
    } as typeof metadata;
    const out = generateTwb(plan, meta);
    // Two measures on rows must be combined with " + ", never concatenated.
    expect(out).toContain(
      '<rows>([sqlproxy.tableaupilot].[sum:Sales:qk] + [sqlproxy.tableaupilot].[sum:Profit:qk])</rows>',
    );
    expect(out).not.toContain('[sum:Sales:qk][sqlproxy.tableaupilot].[sum:Profit:qk]');
    // A single dimension pill stays bare (no parens).
    expect(out).toContain('<cols>[sqlproxy.tableaupilot].[none:Sub-Category:nk]</cols>');
  });

  it('respects the chart type: a line chart uses a Line mark and a continuous date axis', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Sales Trend',
        chartType: 'line',
        dimensions: ['Order Date'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    const meta = {
      ...metadata,
      fields: [
        ...metadata.fields,
        { name: 'Order Date', role: 'dimension', dataType: 'DATE', isDate: true, fieldType: 'ColumnField' },
      ],
    } as typeof metadata;
    const out = generateTwb(plan, meta);
    expect(out).toContain("<mark class='Line' />");
    // Continuous month truncation on the date axis.
    expect(out).toContain("name='[tmn:Order Date:qk]'");
    expect(out).toContain('<cols>[sqlproxy.tableaupilot].[tmn:Order Date:qk]</cols>');
  });

  it('renders a pie chart with color + wedge-size (angle) encodings and empty shelves', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Sales by Category',
        chartType: 'pie',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<mark class='Pie' />");
    expect(out).toContain("<color column='[sqlproxy.tableaupilot].[none:Category:nk]' />");
    expect(out).toContain("<wedge-size column='[sqlproxy.tableaupilot].[sum:Sales:qk]' />");
  });

  it('applies a measure number format as a cell text-format style rule', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Revenue',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum', numberFormat: 'currency', scale: 'millions', decimalPlaces: 1 }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("attr='text-format'");
    expect(out).toContain('c&quot;$&quot;#,##0,,.0M');
  });

  it('renders a KPI worksheet as a big customized-label value', () => {
    // The fixture "Profit Ratio" worksheet is a KPI (kpiMeasure Profit).
    expect(xml).toContain('<customized-label>');
    expect(xml).toContain("attr='mark-labels-show'");
  });

  it('gives the dashboard a title band', () => {
    expect(xml).toContain("type-v2='text'");
    expect(xml).toContain("fontsize='16'>Sales Overview</run>");
    // The title sits in a pinned band inside the outer vertical flow container.
    expect(xml).toContain("param='vert' type-v2='layout-flow'");
  });

  it('nests each sheet inside a flow container (sheet-in-container), not a flat zone', () => {
    // Root is a layout-basic; rows/cells are layout-flow containers.
    expect(xml).toContain("type-v2='layout-basic'");
    expect(xml).toContain("param='horz' type-v2='layout-flow'");
    // Every worksheet leaf is wrapped by a container that carries the card background,
    // while the leaf itself only carries a border/margin style. Assert the exact nesting.
    expect(xml).toMatch(
      /<zone [^>]*param='horz' type-v2='layout-flow'>\s*<zone [^>]*name='Sales by Category'>[\s\S]*?<\/zone>\s*<zone-style>[\s\S]*?background-color' value='#ffffff'[\s\S]*?<\/zone-style>\s*<\/zone>/,
    );
  });

  it('gives the dashboard window a viewpoint per placed worksheet', () => {
    expect(xml).toContain("<window class='dashboard' name='Sales Overview'>");
    expect(xml).toContain('<viewpoints>');
    expect(xml).toContain("<viewpoint name='Sales by Category'>");
  });

  it('emits a worksheet window for each worksheet plus the dashboard window', () => {
    expect(xml).toContain("<window class='worksheet' name='Sales by Category' />");
    expect(xml).toContain("<window class='worksheet' name='Profit Ratio' />");
    expect(xml).toContain("<window class='dashboard' name='Sales Overview'>");
  });

  it('disambiguates a worksheet whose name collides with the dashboard name', () => {
    const plan = makePlan();
    // Single-sheet dashboard where the worksheet shares the dashboard's name.
    plan.dashboardName = 'Sales by Segment';
    plan.worksheets = [
      { name: 'Sales by Segment', chartType: 'bar', dimensions: ['Category'], measures: [{ field: 'Sales', aggregation: 'sum' }], filters: [], calculations: [] },
    ];
    plan.layout.items = [{ worksheet: 'Sales by Segment', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });

    // The worksheet is renamed so it no longer collides with the dashboard.
    expect(out).toContain("<worksheet name='Sales by Segment (sheet)'>");
    expect(out).toContain("<window class='worksheet' name='Sales by Segment (sheet)' />");
    expect(out).toContain("<window class='dashboard' name='Sales by Segment'>");
    // The dashboard zone references the renamed worksheet, not the dashboard.
    expect(out).toContain("name='Sales by Segment (sheet)'");
    // No worksheet element keeps the colliding name.
    expect(out).not.toContain("<worksheet name='Sales by Segment'>");
  });

  it('does not invent fields absent from the plan', () => {
    expect(xml).not.toContain("caption='Discount'");
  });

  it('drops a blank worksheet and never references it from the dashboard', () => {
    const plan = makePlan();
    // A blank sheet: no dimensions, measures, or KPI measure => no visual representation.
    plan.worksheets.push({ name: 'Total Sales', chartType: 'kpi', dimensions: [], measures: [], filters: [], calculations: [] });
    plan.layout.items.push({ worksheet: 'Total Sales', row: 3, col: 0, rowSpan: 1, colSpan: 1, kind: 'kpi' });
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });

    expect(out).not.toContain("<worksheet name='Total Sales'>");
    expect(out).not.toContain("<window class='worksheet' name='Total Sales' />");
    expect(out).not.toContain("name='Total Sales' />"); // no dashboard zone referencing it
  });

  it('applies a dashboard filter across sheets via a shared filter-group (no context without Top-N)', () => {
    // The fixture has a Region "in [East, West]" filter, scope all_worksheets, showAsControl,
    // and NO Top-N chart. Apply-to-all is the shared filter-group; no context filter is used.
    expect(xml).toContain("<filter class='categorical' column='[sqlproxy.tableaupilot].[none:Region:nk]' filter-group='1'>");
    expect(xml).not.toContain("context='true'");
    expect(xml).toContain("<groupfilter function='member' level='[none:Region:nk]' member='&quot;East&quot;' />");
    expect(xml).toContain('<slices>');
    // The filtered field is declared in the worksheet's datasource-dependencies.
    expect(xml).toContain("<column-instance column='[Region]' derivation='None' name='[none:Region:nk]' pivot='key' type='nominal' />");
  });

  it('promotes all slicer filters to context when the dashboard has a Top-N filter (Top-N itself stays non-context)', () => {
    const plan = makePlan();
    // A Top 10 Category-by-Sales filter on a worksheet turns on context for the OTHER filters.
    plan.worksheets[0]!.filters = [
      {
        field: 'Category',
        operator: 'top_n',
        values: [],
        topN: { n: 10, byMeasure: 'Sales', measureAggregation: 'sum', direction: 'top' },
        scope: 'all_worksheets',
        showAsControl: false,
      },
    ] as unknown as (typeof plan.worksheets)[number]['filters'];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The Region slicer becomes a context filter (still apply-to-all via its filter-group).
    expect(out).toContain("column='[sqlproxy.tableaupilot].[none:Region:nk]' context='true' filter-group='1'");
    // The Top-N filter itself is NOT a context filter.
    const categoryFilterLine = out
      .split('\n')
      .find((l) => l.includes('<filter') && l.includes('[none:Category:nk]'));
    expect(categoryFilterLine).toBeDefined();
    expect(categoryFilterLine).not.toContain("context='true'");
  });

  it('renders an interactive filter control on the dashboard panel + wires dashboard deps', () => {
    expect(xml).toContain("type-v2='filter'");
    expect(xml).toContain("param='[sqlproxy.tableaupilot].[none:Region:nk]'");
    expect(xml).toContain("mode='checkdropdown'");
    // Dashboard-level datasource-dependencies present for the control to bind.
    expect(xml).toMatch(/<dashboard[\s\S]*<datasource-dependencies datasource='sqlproxy\.tableaupilot'>/);
    // Panel heading.
    expect(xml).toContain('fontsize=\'12\'>Filters</run>');
  });

  it('reuses a planner integer parameter to drive a Top-N filter (single bound control, no dead duplicate)', () => {
    const plan = makePlan();
    plan.parameters = [
      { name: 'Top N', dataType: 'integer', currentValue: '10', range: { min: 1, max: 20, step: 1 } },
    ];
    // A Top-N filter WITHOUT an explicit nParameter must bind to the existing integer param
    // (not mint a duplicate) so the visible slider is the one that drives the count.
    plan.filters = [
      {
        field: 'Category',
        operator: 'top_n',
        values: [],
        topN: { n: 5, byMeasure: 'Sales', measureAggregation: 'sum', direction: 'top' },
        scope: 'selected_worksheets',
        worksheets: ['Sales by Category'],
        showAsControl: false,
      },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<datasource hasconnection='false' inline='true' name='Parameters'");
    expect(out).toContain("name='[Parameter 1]' param-domain-type='range'");
    expect(out).toContain("<range granularity='1' max='20' min='1' />");
    // Reused, not duplicated: there is no second parameter.
    expect(out).not.toContain("name='[Parameter 2]'");
    // The SAME parameter drives the filter count AND the on-dashboard control.
    expect(out).toContain("count='[Parameters].[Parameter 1]'");
    expect(out).toContain("param='[Parameters].[Parameter 1]' type-v2='paramctrl'");
  });

  it('suppresses an unwired integer parameter control (no dead slider)', () => {
    const plan = makePlan();
    // An integer parameter that no filter references must NOT surface as a dead slider.
    plan.parameters = [
      { name: 'Top N', dataType: 'integer', currentValue: '10', range: { min: 1, max: 20, step: 1 } },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The parameter is still DEFINED in the Parameters datasource...
    expect(out).toContain("name='[Parameter 1]' param-domain-type='range'");
    // ...but there is no dead paramctrl control (nothing drives).
    expect(out).not.toContain("type-v2='paramctrl'");
  });

  it('shows all members for a dimension filter with no preset values (interactive default)', () => {
    const plan = makePlan();
    plan.filters = [
      { field: 'Category', operator: 'in', values: [], scope: 'all_worksheets', showAsControl: true },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<groupfilter function='level-members' level='[none:Category:nk]' user:ui-enumeration='all' user:ui-marker='enumerate' />");
  });

  it('does not reserve a control panel with no filters, parameters, or legends', () => {
    const plan = makePlan();
    // KPI-only board: no color/size legends, no filters, no parameters => no side panel.
    plan.worksheets = [
      {
        name: 'Total Sales',
        chartType: 'kpi',
        dimensions: [],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.parameters = [];
    plan.layout = { ...plan.layout, items: [] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).not.toContain("type-v2='filter'");
    expect(out).not.toContain("type-v2='paramctrl'");
    expect(out).not.toContain("type-v2='color'");
    // No pinned 200px Filters panel is reserved.
    expect(out).not.toContain("fixed-size='200'");
  });

  it('emits a REAL ranked Top-N filter driven by an auto-created Top N parameter', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Top Regions',
        chartType: 'horizontal_bar',
        dimensions: ['Region'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [
          {
            field: 'Region',
            operator: 'top_n',
            values: [],
            topN: { n: 5, byMeasure: 'Sales', measureAggregation: 'sum', direction: 'top' },
            scope: 'selected_worksheets',
            worksheets: ['Top Regions'],
            showAsControl: false,
          },
        ],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.parameters = [];
    plan.layout = { ...plan.layout, items: [] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // A Top N parameter is auto-created and referenced as the filter's count.
    expect(out).toContain("<datasource hasconnection='false' inline='true' name='Parameters'");
    expect(out).toContain("caption='Top N Region'");
    expect(out).toContain(
      "<groupfilter count='[Parameters].[Parameter 1]' end='top' function='end' units='records' user:ui-marker='end' user:ui-top-by-field='true'>",
    );
    expect(out).toContain("<groupfilter direction='DESC' expression='SUM([Sales])' function='order' user:ui-marker='order'>");
    // The worksheet declares its Parameters dependency + control renders as a slider.
    expect(out).toContain("<datasource-dependencies datasource='Parameters'>");
    expect(out).toContain("param='[Parameters].[Parameter 1]' type-v2='paramctrl'");
  });

  it('declares the Top-N ranking measure column-INSTANCE so the ranking actually works', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Top Regions',
        chartType: 'horizontal_bar',
        dimensions: ['Region'],
        // Note: the ranked measure (Sales) is NOT plotted on a shelf here — it exists only
        // as the Top-N ranking measure, so its declaration must come from the filter.
        measures: [{ field: 'Quantity', aggregation: 'sum' }],
        filters: [
          {
            field: 'Region',
            operator: 'top_n',
            values: [],
            topN: { n: 5, byMeasure: 'Sales', measureAggregation: 'sum', direction: 'top' },
            scope: 'selected_worksheets',
            worksheets: ['Top Regions'],
            showAsControl: false,
          },
        ],
        calculations: [],
      },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.parameters = [];
    plan.layout = { ...plan.layout, items: [] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    const ws = out.slice(out.indexOf("<worksheet name='Top Regions'>"), out.indexOf('</worksheet>', out.indexOf("<worksheet name='Top Regions'>")));
    // Both the base column AND the column-instance for the ranking measure are declared.
    expect(ws).toContain("<column datatype='real' name='[Sales]' role='measure' type='quantitative' />");
    expect(ws).toContain("<column-instance column='[Sales]' derivation='Sum' name='[sum:Sales:qk]' pivot='key' type='quantitative' />");
    // The order expression matches the declared aggregation.
    expect(ws).toContain("expression='SUM([Sales])'");
  });

  it('auto-detects an already-aggregated calc measure and places it as AGG (usr), even without the flag', () => {
    const plan = makePlan();
    // A worksheet-local calc whose formula is aggregated (SUM/SUM); referenced as a measure
    // WITHOUT the aggregated flag. The generator must still emit a User-derivation pill.
    plan.worksheets = [
      {
        name: 'Ratio by Category',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'Profit Ratio', aggregation: 'sum' }],
        filters: [],
        calculations: [
          { name: 'Profit Ratio', formula: 'SUM([Profit])/SUM([Sales])', referencedFields: ['Profit', 'Sales'], role: 'measure' },
        ],
      },
    ] as unknown as typeof plan.worksheets;
    plan.layout = { ...plan.layout, items: [{ worksheet: 'Ratio by Category', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The calc is defined locally with a unique internal name (caption preserved).
    const internal = /<column [^>]*caption='Profit Ratio'[^>]*name='\[(Calculation_\d+)\]'/.exec(out)?.[1];
    expect(internal).toBeTruthy();
    const ws = out.slice(out.indexOf("<worksheet name='Ratio by Category'>"));
    // Placed as AGG(field): User derivation, NOT re-wrapped in SUM(...).
    expect(ws).toContain(`name='[usr:${internal}:qk]'`);
    expect(ws).toContain("derivation='User'");
    expect(ws).not.toContain(`sum:${internal}`);
  });

  it('gives every non-KPI worksheet a bold, size-12 title (KPI titles stay hidden)', () => {
    // Sales by Category (bar) gets a bold-12 title layout; Profit Ratio (kpi) does not.
    expect(xml).toMatch(
      /<worksheet name='Sales by Category'>\s*<layout-options>\s*<title>[\s\S]*?fontsize='12'>Sales by Category<\/run>/,
    );
    const kpiBlock = xml.slice(xml.indexOf("<worksheet name='Profit Ratio'>"));
    expect(kpiBlock.slice(0, 120)).not.toContain('<layout-options>');
  });

  it('does NOT auto-add color/size legends to the panel (only when the user asks)', () => {
    // Sales by Category is a bar colored by Category, but legends are no longer auto-added:
    // the Filters panel stays clean unless a legend is explicitly requested.
    expect(xml).not.toContain("type-v2='color'");
    expect(xml).not.toContain("pane-specification-id='0'");
  });

  it('keeps KPI rows pure: a chart sharing a KPI row is pushed to its own row', () => {
    const plan = makePlan();
    // Put the KPI and a chart on the SAME row (row 0) — the generator must split them.
    plan.layout = {
      ...plan.layout,
      items: [
        { worksheet: 'Profit Ratio', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'kpi' },
        { worksheet: 'Sales by Category', row: 0, col: 1, rowSpan: 1, colSpan: 3, kind: 'chart' },
      ],
    } as typeof plan.layout;
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The KPI row (pinned fixed-size) must not also contain the bar chart's sheet zone.
    const kpiRow = out.match(/<zone fixed-size='130'[\s\S]*?\n {10}<\/zone>/);
    expect(kpiRow).toBeTruthy();
    expect(kpiRow![0]).toContain("name='Profit Ratio'");
    expect(kpiRow![0]).not.toContain("name='Sales by Category'");
  });

  it('supports automatic and range dashboard sizes', () => {
    const auto = makePlan();
    auto.layout = { ...auto.layout, size: 'automatic' } as typeof auto.layout;
    expect(generateTwb(auto, metadata)).toContain("<size sizing-mode='automatic' />");

    const range = makePlan();
    range.layout = {
      ...range.layout,
      size: 'range',
      minWidth: 800,
      minHeight: 600,
      maxWidth: 1400,
      maxHeight: 900,
    } as typeof range.layout;
    expect(generateTwb(range, metadata)).toContain(
      "<size maxheight='900' maxwidth='1400' minheight='600' minwidth='800' sizing-mode='range' />",
    );
  });

  it('adds a default "use as filter" action, excluding KPI sheets as sources', () => {
    // The fixture has a bar + a KPI on the dashboard and no explicit actions.
    expect(xml).toContain('<actions>');
    expect(xml).toContain("caption='Filter on Sales Overview'");
    expect(xml).toContain("<activation auto-clear='true' type='on-select' />");
    expect(xml).toContain("<command command='tsc:tsl-filter'>");
    expect(xml).toContain("<param name='special-fields' value='all' />");
    expect(xml).toContain("<param name='target' value='Sales Overview' />");
    // The KPI card is excluded as a filter SOURCE (clicking a big number shouldn't filter all).
    expect(xml).toContain("<exclude-sheet name='Profit Ratio' />");
    // The <actions> section precedes <worksheets> (workbook-level, correct position).
    expect(xml.indexOf('<actions>')).toBeLessThan(xml.indexOf('<worksheets>'));
  });

  it('honors an explicit hover filter action with a custom caption', () => {
    const plan = makePlan();
    plan.actions = [{ type: 'filter', caption: 'Cross-filter', runOn: 'hover', excludeSheets: [] }];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("caption='Cross-filter'");
    expect(out).toContain("<activation auto-clear='true' type='on-hover' />");
    expect(out).toContain("<exclude-sheet name='Profit Ratio' />");
  });

  it('omits actions when interactivity is explicitly disabled (type "none")', () => {
    const plan = makePlan();
    plan.actions = [{ type: 'none', runOn: 'select', excludeSheets: [] }];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).not.toContain('<actions>');
  });

  it('emits no actions when the dashboard has fewer than two sheets', () => {
    const plan = makePlan();
    plan.worksheets = [
      { name: 'Total Sales', chartType: 'kpi', dimensions: [], measures: [{ field: 'Sales', aggregation: 'sum' }], filters: [], calculations: [] },
    ] as unknown as typeof plan.worksheets;
    plan.filters = [];
    plan.parameters = [];
    plan.layout = { ...plan.layout, items: [] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).not.toContain('<actions>');
  });

  it('draws an average reference line (with fill bands) against a measure axis', () => {
    const plan = makePlan();
    plan.worksheets[0]!.referenceLines = [
      { field: 'Sales', aggregation: 'sum', formula: 'average', scope: 'per-pane', labelType: 'automatic', fillAbove: '#dfedeb', fillBelow: '#f9f3ef' },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain(
      "<reference-line axis-column='[sqlproxy.tableaupilot].[sum:Sales:qk]' enable-instant-analytics='true' formula='average' id='refline0' label-type='automatic' scope='per-pane' value-column='[sqlproxy.tableaupilot].[sum:Sales:qk]' z-order='1' />",
    );
    expect(out).toContain("<style-rule element='refline'>");
    expect(out).toContain("<format attr='fill-above' id='refline0' value='#dfedeb' />");
    expect(out).toContain("<format attr='fill-below' id='refline0' value='#f9f3ef' />");
  });

  it('draws a constant reference line at a fixed value', () => {
    const plan = makePlan();
    plan.worksheets[0]!.referenceLines = [
      { field: 'Sales', aggregation: 'sum', formula: 'constant', value: 100000, scope: 'per-table', labelType: 'value' },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain(
      "<reference-line axis-column='[sqlproxy.tableaupilot].[sum:Sales:qk]' enable-instant-analytics='true' id='refline0' label-type='value' scope='per-table' value='100000' z-order='1' />",
    );
    // A constant line has no aggregate formula/value-column.
    const line = out.split('\n').find((l) => l.includes('<reference-line'))!;
    expect(line).not.toContain('formula=');
    expect(line).not.toContain('value-column=');
  });

  it('adds grand totals to a worksheet rows/cols', () => {
    const plan = makePlan();
    plan.worksheets[0]!.grandTotals = { row: true, column: true };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<rows total='true'>");
    expect(out).toContain("<cols total='true'>");
  });

  it('applies a per-member color palette to the color-encoded dimension', () => {
    const plan = makePlan();
    // Sales by Category (bar) colors by Category.
    plan.worksheets[0]!.colorMap = {
      field: 'Category',
      colors: [
        { value: 'Furniture', color: '#4e79a7' },
        { value: 'Technology', color: '#f28e2b' },
      ],
    };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<encoding attr='color' field='[none:Category:nk]' type='palette'>");
    expect(out).toContain("<map to='#4e79a7'>");
    expect(out).toContain('<bucket>&quot;Furniture&quot;</bucket>');
    expect(out).toContain("<map to='#f28e2b'>");
  });

  it('honors a custom worksheet title font/size/color', () => {
    const plan = makePlan();
    plan.worksheets[0]!.formatting = { titleFormat: { fontName: 'Georgia', fontSize: 14, fontColor: '#333333', bold: true } };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<run bold='true' fontcolor='#333333' fontname='Georgia' fontsize='14'>Sales by Category</run>");
  });

  it('applies dashboard background, container background, and title font', () => {
    const plan = makePlan();
    plan.layout = {
      ...plan.layout,
      backgroundColor: '#101820',
      containerBackground: '#222222',
      titleFormat: { fontName: 'Arial', fontSize: 22, fontColor: '#ffcc00', bold: true },
    } as typeof plan.layout;
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // Dashboard background.
    expect(out).toContain("<format attr='background-color' value='#101820' />");
    // Container background (used in a sheet container zone-style).
    expect(out).toContain("<format attr='background-color' value='#222222' />");
    // Title band font.
    expect(out).toContain("fontcolor='#ffcc00' fontname='Arial' fontsize='22'>Sales Overview</run>");
  });

  it('kitchen sink: filters + legend + actions + refline + totals + colors + theme all coexist', () => {
    const plan = makePlan();
    // Bar (Sales by Category) carries color palette + reference line (with fill) + grand totals + title font.
    plan.worksheets[0]!.colorMap = { field: 'Category', colors: [{ value: 'Furniture', color: '#4e79a7' }] };
    plan.worksheets[0]!.referenceLines = [
      { field: 'Sales', aggregation: 'sum', formula: 'average', scope: 'per-pane', labelType: 'automatic', fillAbove: '#dfedeb' },
    ];
    plan.worksheets[0]!.grandTotals = { row: false, column: true };
    plan.worksheets[0]!.formatting = { titleFormat: { fontName: 'Georgia', fontSize: 14, fontColor: '#333333', bold: true } };
    // Custom hover interactivity.
    plan.actions = [{ type: 'filter', caption: 'Cross-filter', runOn: 'hover', excludeSheets: [] }];
    // Dashboard theme + range size.
    plan.layout = {
      ...plan.layout,
      size: 'range',
      minWidth: 800,
      minHeight: 600,
      maxWidth: 1400,
      maxHeight: 900,
      backgroundColor: '#101820',
      containerBackground: '#222222',
      titleFormat: { fontName: 'Arial', fontSize: 22, fontColor: '#ffcc00', bold: true },
    } as typeof plan.layout;
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });

    // Interactive filter control in the right panel; legends are NOT auto-added.
    expect(out).toContain("type-v2='filter'");
    expect(out).not.toContain("type-v2='color'");
    // Dashboard action (hover).
    expect(out).toContain("caption='Cross-filter'");
    expect(out).toContain("<activation auto-clear='true' type='on-hover' />");
    // Reference line + fill band.
    expect(out).toContain("formula='average' id='refline0'");
    expect(out).toContain("<format attr='fill-above' id='refline0' value='#dfedeb' />");
    // Grand total (column).
    expect(out).toContain("<cols total='true'>");
    // Color palette.
    expect(out).toContain("<encoding attr='color' field='[none:Category:nk]' type='palette'>");
    // Theme: dashboard bg, container bg, both title fonts, range size.
    expect(out).toContain("<format attr='background-color' value='#101820' />");
    expect(out).toContain("<format attr='background-color' value='#222222' />");
    expect(out).toContain("fontcolor='#ffcc00' fontname='Arial' fontsize='22'>Sales Overview</run>");
    expect(out).toContain("<run bold='true' fontcolor='#333333' fontname='Georgia' fontsize='14'>Sales by Category</run>");
    expect(out).toContain("sizing-mode='range'");
  });

  it('internalizes a datasource-defined calc so it renders (unique name + its own formula)', () => {
    // The datasource DEFINES "Profit Margin %" as a calc WITH a formula (from the Metadata
    // API). Referencing it must DEFINE it locally under a unique internal name — never leave
    // it as an empty physical column (the blank-chart bug).
    const dsWithCalc = {
      ...metadata,
      fields: [
        ...metadata.fields,
        {
          name: 'Profit Margin %',
          role: 'measure',
          dataType: 'REAL',
          isDate: false,
          fieldType: 'CalculatedField',
          formula: 'SUM([Profit]) / SUM([Sales])',
        },
      ],
    } as typeof metadata;
    const plan = makePlan();
    // Reference the datasource calc on a shelf (the planner does NOT re-create it).
    plan.worksheets[0]!.measures.push({ field: 'Profit Margin %', aggregation: 'sum', aggregated: true } as never);
    const out = generateTwb(plan, dsWithCalc, { serverHost: 'prod-in-a.online.tableau.com' });
    // Defined LOCALLY with a unique internal name + its formula (so it computes → not blank).
    const internal = /<column [^>]*caption='Profit Margin %'[^>]*name='\[(Calculation_\d+)\]'/.exec(out)?.[1];
    expect(internal).toBeTruthy();
    expect(out).toContain("<calculation class='tableau' formula='SUM([Profit]) / SUM([Sales])' />");
    // Never emitted under its literal name (which would collide with the datasource → blank),
    // and never a physical remote column.
    expect(out).not.toContain("name='[Profit Margin %]'");
    expect(out).not.toContain('<remote-name>Profit Margin %</remote-name>');
    // The worksheet references the internalized field with User derivation.
    expect(out).toContain(`name='[usr:${internal}:qk]'`);
  });

  it('still defines a calculated field with a distinct (non-colliding) name', () => {
    const plan = makePlan();
    plan.calculatedFields = [
      { name: 'Profit Margin % (Adj)', formula: 'SUM([Profit]) / SUM([Sales]) * 1.1', referencedFields: ['Profit', 'Sales'], role: 'measure' },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("caption='Profit Margin % (Adj)'");
    expect(out).toContain("<calculation class='tableau' formula='SUM([Profit]) / SUM([Sales]) * 1.1' />");
  });

  it('parses the calc field name from a Tableau "already defined" publish error', () => {
    const msg =
      "Tableau API error (400 [400011]): Bad Request There was a problem publishing the file 'Sales Analysis.twbx'.. " +
      "(0x2E788ECE : ... Ignoring calculated field '[Profit Margin % (Calc)]', field is already defined by data source. )";
    expect(parseAlreadyDefinedCalcFields(msg)).toEqual(['Profit Margin % (Calc)']);
  });

  it('parses multiple already-defined calc fields from one error message', () => {
    const msg =
      "Ignoring calculated field '[Profit Margin %]', field is already defined by data source. " +
      "Ignoring calculated field '[Discount Rate]', field is already defined by data source.";
    expect(parseAlreadyDefinedCalcFields(msg)).toEqual(['Profit Margin %', 'Discount Rate']);
  });

  it('removeCalculatedFields drops matching calcs (case/space-insensitive) from plan + worksheets', () => {
    const plan = makePlan();
    plan.calculatedFields = [
      { name: 'Profit Margin %', formula: 'SUM([Profit])/SUM([Sales])', referencedFields: ['Profit', 'Sales'], role: 'measure' },
    ];
    // The fixture already has a worksheet calc "Profit Ratio"; add a colliding one to a ws.
    plan.worksheets[0]!.calculations = [
      { name: 'profit margin  %', formula: 'x', referencedFields: [], role: 'measure' },
    ];
    const out = removeCalculatedFields(plan, ['Profit Margin %']);
    expect(out.calculatedFields).toHaveLength(0);
    expect(out.worksheets[0]!.calculations).toHaveLength(0);
    // Original plan is untouched (pure function).
    expect(plan.calculatedFields).toHaveLength(1);
  });

  it('shows an apply-to-all filter control on EVERY dashboard', () => {
    const plan = makePlan();
    // A global (all_worksheets) Region filter shown as a control.
    plan.filters = [{ field: 'Region', operator: 'in', values: [], scope: 'all_worksheets', showAsControl: true }];
    plan.dashboards = [
      { ...plan.layout, name: 'Board A', items: [{ worksheet: 'Sales by Category', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }] },
      { ...plan.layout, name: 'Board B', items: [{ worksheet: 'Profit Ratio', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'kpi' }] },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // The Region filter control appears once per board (anchored to each board's own sheet).
    expect(out).toContain("name='Sales by Category' param='[sqlproxy.tableaupilot].[none:Region:nk]' show-apply='true' type-v2='filter'");
    expect(out).toContain("name='Profit Ratio' param='[sqlproxy.tableaupilot].[none:Region:nk]' show-apply='true' type-v2='filter'");
  });

  it('places a Top-N parameter control only on the board hosting its chart (not others)', () => {
    const plan = makePlan();
    // A worksheet-local Top-N filter on the bar (Sales by Category), ranked by Sales.
    plan.worksheets[0]!.filters = [
      { field: 'Category', operator: 'top_n', values: [], scope: 'selected_worksheets', showAsControl: false, topN: { n: 5, byMeasure: 'Sales', measureAggregation: 'sum', direction: 'top' } },
    ];
    plan.dashboards = [
      { ...plan.layout, name: 'Board A', items: [{ worksheet: 'Sales by Category', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }] },
      { ...plan.layout, name: 'Board B', items: [{ worksheet: 'Profit Ratio', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'kpi' }] },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    // Board A (with the ranked bar) has the Top-N paramctrl; Board B (KPI only) does not.
    const boardA = out.slice(out.indexOf("<dashboard name='Board A'>"), out.indexOf("<dashboard name='Board B'>"));
    const boardB = out.slice(out.indexOf("<dashboard name='Board B'>"));
    expect(boardA).toContain("type-v2='paramctrl'");
    expect(boardB).not.toContain("type-v2='paramctrl'");
  });

  it('never emits a blank/empty zone in a dashboard panel', () => {
    const plan = makePlan();
    plan.filters = [{ field: 'Region', operator: 'in', values: [], scope: 'all_worksheets', showAsControl: true }];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).not.toContain("type-v2='empty'");
  });

  it('detail chart type places all fields (dims + measures) discrete on Rows', () => {
    const plan = makePlan();
    plan.worksheets = [
      {
        name: 'Order Details',
        chartType: 'detail',
        dimensions: ['Category', 'Region'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
    ];
    plan.layout = { ...plan.layout, items: [{ worksheet: 'Order Details', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }] };
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    const ws = out.slice(out.indexOf("<worksheet name='Order Details'>"));
    // All three fields land on <rows>; the measure is a DISCRETE (ordinal 'ok') pill.
    expect(ws).toMatch(/<rows>\(\[sqlproxy\.tableaupilot\]\.\[none:Category:nk\] \/ \[sqlproxy\.tableaupilot\]\.\[none:Region:nk\] \/ \[sqlproxy\.tableaupilot\]\.\[sum:Sales:ok\]\)<\/rows>/);
    expect(ws).toContain('<cols></cols>');
  });

  it('honors a user-selected color-mark field (measure → continuous color)', () => {
    const plan = makePlan();
    plan.worksheets[0]!.formatting = { colorField: 'Profit' }; // color the bar by a measure
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    const ws = out.slice(out.indexOf("<worksheet name='Sales by Category'>"));
    // A measure on color encodes as an aggregated measure pill (sum:Profit).
    expect(ws).toContain("<color column='[sqlproxy.tableaupilot].[sum:Profit:qk]' />");
    // The default category color encoding is replaced (no Category on color).
    expect(ws).not.toContain("<color column='[sqlproxy.tableaupilot].[none:Category:nk]' />");
  });

  it('emits multiple <dashboard> boards (and windows) when plan.dashboards is set', () => {
    const plan = makePlan();
    plan.dashboards = [
      {
        ...plan.layout,
        name: 'Sales Board',
        items: [{ worksheet: 'Sales by Category', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }],
      },
      {
        ...plan.layout,
        name: 'Profit Board',
        items: [{ worksheet: 'Profit Ratio', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'kpi' }],
      },
    ];
    const out = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });
    expect(out).toContain("<dashboard name='Sales Board'>");
    expect(out).toContain("<dashboard name='Profit Board'>");
    // One dashboard <window> per board.
    expect((out.match(/<window class='dashboard'/g) ?? []).length).toBe(2);
    // Each board hosts only its own sheet's viewpoint.
    expect(out).toContain("<window class='dashboard' name='Sales Board'>");
    expect(out).toContain("<window class='dashboard' name='Profit Board'>");
  });

  it('escapes a datasource name containing special characters', () => {
    const plan = makePlan();
    plan.dashboardName = 'A & B';
    const out = generateTwb(plan, metadata);
    expect(out).toContain("name='A &amp; B'");
  });
});
