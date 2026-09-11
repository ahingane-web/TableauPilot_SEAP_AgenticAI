/**
 * Parameter compilation.
 *
 * Tableau stores parameters in a special inline pseudo-datasource
 * `<datasource name='Parameters'>` as `<column ... param-domain-type='...'>` with a
 * nested `<calculation>` holding the current value. This module compiles a validated
 * {@link ParameterSpec} into that datasource and exposes the ref + control mode a
 * dashboard parameter control needs. The real (locked) datasource is never touched.
 */
import type { ParameterSpec } from '../../schemas/parameterSpec.js';
import { escapeXml } from './xml.js';

const WORKBOOK_VERSION = '18.1';

export interface ResolvedParameter {
  spec: ParameterSpec;
  /** Internal name without brackets, e.g. `Parameter 1`. */
  name: string;
  /** Control/consumer reference `[Parameters].[Parameter N]`. */
  ref: string;
  /** Dashboard parameter-control mode. */
  controlMode: 'dropdown' | 'slider' | 'type_in';
  /** The `<column>` block for the Parameters datasource (2-level / 6-space indent). */
  columnXml: string;
  /** The same `<column>` block re-indented for a worksheet's datasource-dependencies. */
  depColumnXml: string;
}

type TwbType = 'integer' | 'real' | 'string' | 'boolean' | 'date';

/** Map our ParameterSpec dataType to a .twb datatype. */
function twbType(dt: ParameterSpec['dataType']): TwbType {
  switch (dt) {
    case 'integer':
      return 'integer';
    case 'float':
      return 'real';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    default:
      return 'string';
  }
}

function roleAndType(dt: TwbType): { role: 'measure' | 'dimension'; type: 'quantitative' | 'nominal' | 'ordinal' } {
  if (dt === 'integer' || dt === 'real') return { role: 'measure', type: 'quantitative' };
  if (dt === 'date') return { role: 'dimension', type: 'ordinal' };
  return { role: 'dimension', type: 'nominal' };
}

/** Quote a raw value for a parameter based on its data type. */
function encodeValue(dt: TwbType, raw: string): string {
  if (dt === 'string') return `&quot;${escapeXml(raw)}&quot;`;
  if (dt === 'boolean') return raw === 'true' || raw === '1' ? 'true' : 'false';
  return escapeXml(raw);
}

/** Resolve parameter specs into internal names, refs, control modes and column XML. */
export function resolveParameters(specs: ParameterSpec[]): ResolvedParameter[] {
  return specs
    .filter((s) => s.name.trim().length > 0)
    .map((spec, i) => {
      const name = `Parameter ${i + 1}`;
      const dt = twbType(spec.dataType);
      const { role, type } = roleAndType(dt);
      const domain: 'any' | 'list' | 'range' = spec.allowableValues?.length
        ? 'list'
        : spec.range
          ? 'range'
          : 'any';
      const rawCurrent = spec.currentValue ?? (dt === 'integer' || dt === 'real' ? '0' : dt === 'boolean' ? 'true' : '');
      const value = encodeValue(dt, rawCurrent);

      // Build the <column> block at a given base indent (Parameters ds uses 6 spaces;
      // a worksheet's <datasource-dependencies> uses 12). Members/range indent off `pad`.
      const buildColumn = (pad: string): string => {
        let membersXml = '';
        if (domain === 'list' && spec.allowableValues?.length) {
          membersXml =
            `\n${pad}  <members>\n` +
            spec.allowableValues.map((v) => `${pad}    <member value='${encodeValue(dt, v)}' />`).join('\n') +
            `\n${pad}  </members>`;
        }
        let rangeXml = '';
        if (domain === 'range' && spec.range) {
          const attrs = [
            spec.range.step != null ? `granularity='${spec.range.step}'` : '',
            spec.range.max != null ? `max='${spec.range.max}'` : '',
            spec.range.min != null ? `min='${spec.range.min}'` : '',
          ]
            .filter(Boolean)
            .join(' ');
          if (attrs) rangeXml = `\n${pad}  <range ${attrs} />`;
        }
        return (
          `${pad}<column caption='${escapeXml(spec.name.trim())}' datatype='${dt}' name='[${name}]' ` +
          `param-domain-type='${domain}' role='${role}' type='${type}' value='${value}'>\n` +
          `${pad}  <calculation class='tableau' formula='${value}' />` +
          membersXml +
          rangeXml +
          `\n${pad}</column>`
        );
      };

      const controlMode: ResolvedParameter['controlMode'] =
        domain === 'list' ? 'dropdown' : domain === 'range' ? 'slider' : 'type_in';

      return {
        spec,
        name,
        ref: `[Parameters].[${name}]`,
        controlMode,
        columnXml: buildColumn('      '),
        depColumnXml: buildColumn('            '),
      };
    });
}

/**
 * Render a worksheet-level `<datasource-dependencies datasource='Parameters'>` block for
 * the parameters a worksheet references (e.g. a Top-N filter's N parameter). Returns '' if
 * none. The columns are the same parameter columns, re-indented to the worksheet depth.
 */
export function renderWorksheetParameterDeps(params: ResolvedParameter[]): string {
  if (params.length === 0) return '';
  return [
    `          <datasource-dependencies datasource='Parameters'>`,
    ...params.map((p) => p.depColumnXml),
    `          </datasource-dependencies>`,
  ].join('\n');
}

/** Render the `<datasource name='Parameters'>` block, or '' when there are none. */
export function renderParametersDatasource(resolved: ResolvedParameter[]): string {
  if (resolved.length === 0) return '';
  return [
    `    <datasource hasconnection='false' inline='true' name='Parameters' version='${WORKBOOK_VERSION}'>`,
    `      <aliases enabled='yes' />`,
    ...resolved.map((r) => r.columnXml),
    `    </datasource>`,
  ].join('\n');
}
