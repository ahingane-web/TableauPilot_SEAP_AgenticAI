import React, { useEffect, useRef, useState } from 'react';

/** Relationship cardinality options shown in the relationship builder. */
export type ModelCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
/** SQL join type options shown in the physical-join builder. */
export type ModelJoinType = 'inner' | 'left' | 'right' | 'full';
/** Multi-object data-modeling mode: Tableau relationships vs a physical join. */
export type ModelMode = 'relationship' | 'join';

/** A data-modeling edge between two objects/sheets. */
export interface ModelRelationship {
  leftObject: string;
  leftField: string;
  rightObject: string;
  rightField: string;
  cardinality: ModelCardinality;
  joinType: ModelJoinType;
}

/** A described field (name/label/type) used for the join-field dropdowns. */
export interface ModelFieldInfo {
  name: string;
  label: string;
  type: string;
}

/** The model emitted upward whenever the user's selections change. */
export interface DataModel {
  objects: string[];
  relationships: ModelRelationship[];
  mode: ModelMode;
  /** True when the current selections form a publishable model. */
  valid: boolean;
}

/** A table row in the relationship builder. Index 0 is the primary object; each later
 * row carries the relationship (`rel`) that connects it to a prior table. */
interface TableDraft {
  object: string;
  rel?: { leftObject: string; leftField: string; rightField: string; cardinality: ModelCardinality; joinType: ModelJoinType };
}

const CARDINALITY_OPTIONS: Array<{ value: ModelCardinality; label: string }> = [
  { value: 'many-to-many', label: 'Many-to-many (neither unique)' },
  { value: 'many-to-one', label: 'Many-to-one (right side unique)' },
  { value: 'one-to-many', label: 'One-to-many (left side unique)' },
  { value: 'one-to-one', label: 'One-to-one (both unique)' },
];

const JOIN_TYPE_OPTIONS: Array<{ value: ModelJoinType; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'inner', label: 'Inner' },
  { value: 'full', label: 'Full Outer' },
];

export interface DataModelBuilderProps {
  /** The available objects/sheets to model (name = api id, label = display). */
  objects: Array<{ name: string; label: string }>;
  /** Load a given object/sheet's fields for the join-field dropdowns. */
  describe: (name: string) => Promise<ModelFieldInfo[]>;
  /** Emitted whenever the model changes (selections, relationships, mode, validity). */
  onChange: (model: DataModel) => void;
  /** Grey the section out (e.g. before a connection/upload has produced objects). */
  disabled?: boolean;
  /** Singular noun for one modeled entity ("object" | "sheet"). Used in labels/messages. */
  noun?: string;
  /** Plural noun ("objects" | "sheets"). */
  nounPlural?: string;
}

/**
 * The shared "Model your data" step used by BOTH the Salesforce and Excel build flows.
 *
 * It owns the modeling state (primary + additional tables, relationships/join, mode) and
 * reports the resulting model upward via {@link DataModelBuilderProps.onChange}. The parent
 * connector supplies the list of `objects` and a `describe` function; everything else — the
 * relationship/join UI and its validation — is identical across connectors, which is exactly
 * what keeps the Excel flow "same as Salesforce, only using sheets instead of objects".
 */
export function DataModelBuilder({
  objects,
  describe,
  onChange,
  disabled,
  noun = 'object',
  nounPlural = 'objects',
}: DataModelBuilderProps): React.ReactElement {
  const [relEnabled, setRelEnabled] = useState(false);
  const [mode, setMode] = useState<ModelMode>('relationship');
  const [tables, setTables] = useState<TableDraft[]>([{ object: '' }]);
  const [fieldsByObject, setFieldsByObject] = useState<Record<string, ModelFieldInfo[]>>({});
  const [describing, setDescribing] = useState<Record<string, boolean>>({});

  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  async function loadFields(object: string): Promise<void> {
    const name = object.trim();
    if (!name || fieldsByObject[name] || describing[name]) return;
    setDescribing((p) => ({ ...p, [name]: true }));
    try {
      const fields = await describe(name);
      setFieldsByObject((p) => ({ ...p, [name]: fields }));
    } catch {
      setFieldsByObject((p) => ({ ...p, [name]: [] }));
    } finally {
      setDescribing((p) => ({ ...p, [name]: false }));
    }
  }

  function setPrimaryObject(value: string): void {
    setTables((prev) => [{ ...prev[0], object: value }, ...prev.slice(1)]);
    void loadFields(value);
  }

  function toggleRelationships(enabled: boolean): void {
    setRelEnabled(enabled);
    if (!enabled) setTables((prev) => prev.slice(0, 1)); // collapse back to the primary object
  }

  function addTable(): void {
    setTables((prev) => {
      const priorObject = prev[0]?.object ?? '';
      return [
        ...prev,
        {
          object: '',
          rel: { leftObject: priorObject, leftField: '', rightField: '', cardinality: 'many-to-many', joinType: 'left' },
        },
      ];
    });
  }

  function removeTable(index: number): void {
    setTables((prev) => prev.filter((_, i) => i !== index));
  }

  function setTableObject(index: number, value: string): void {
    setTables((prev) => prev.map((t, i) => (i === index ? { ...t, object: value } : t)));
    void loadFields(value);
  }

  function updateRel(index: number, patch: Partial<NonNullable<TableDraft['rel']>>): void {
    setTables((prev) => prev.map((t, i) => (i === index && t.rel ? { ...t, rel: { ...t.rel, ...patch } } : t)));
    if (patch.leftObject) void loadFields(patch.leftObject);
  }

  // Report the current model upward. Kept in a ref so a parent re-render (new onChange
  // identity) never re-fires this effect — it runs only when the user's selections change.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const visibleTables = relEnabled ? tables : tables.slice(0, 1);
    const selectedObjects = visibleTables.map((t) => t.object.trim());
    const allHaveObject = selectedObjects.every((o) => o.length > 0);
    const hasDupes = new Set(selectedObjects).size !== selectedObjects.length;
    const relsComplete =
      !relEnabled ||
      tables.slice(1).every((t) => t.rel && t.rel.leftObject && t.rel.leftField && t.rel.rightField && t.object.trim());
    const enoughTables = !relEnabled || tables.length >= 2;
    const valid = Boolean(allHaveObject && !hasDupes && relsComplete && enoughTables && selectedObjects[0]);
    const relationships: ModelRelationship[] = relEnabled
      ? tables
          .slice(1)
          .filter((t) => t.object.trim() && t.rel)
          .map((t) => ({
            leftObject: t.rel!.leftObject,
            leftField: t.rel!.leftField,
            rightObject: t.object.trim(),
            rightField: t.rel!.rightField,
            cardinality: t.rel!.cardinality,
            joinType: t.rel!.joinType,
          }))
      : [];
    onChangeRef.current({ objects: selectedObjects, relationships, mode: relEnabled ? mode : 'relationship', valid });
  }, [tables, relEnabled, mode]);

  const hasDupes = (() => {
    const visible = relEnabled ? tables : tables.slice(0, 1);
    const sel = visible.map((t) => t.object.trim());
    return new Set(sel).size !== sel.length;
  })();

  const ObjectSelect = ({ value, onChange: onSel }: { value: string; onChange: (v: string) => void }): React.ReactElement => (
    <select value={value} onChange={(e) => onSel(e.target.value)}>
      <option value="">Select {noun === 'object' ? 'an' : 'a'} {noun}…</option>
      {objects.map((o) => (
        <option key={o.name} value={o.name}>
          {o.label === o.name ? o.name : `${o.label} (${o.name})`}
        </option>
      ))}
    </select>
  );

  const FieldSelect = ({
    object,
    value,
    onChange: onSel,
  }: {
    object: string;
    value: string;
    onChange: (v: string) => void;
  }): React.ReactElement => {
    const fields = fieldsByObject[object.trim()] ?? [];
    return (
      <select value={value} onChange={(e) => onSel(e.target.value)} disabled={!object || describing[object.trim()]}>
        <option value="">{describing[object.trim()] ? 'Loading fields…' : 'Select a field…'}</option>
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label === f.name ? f.name : `${f.label} (${f.name})`}
          </option>
        ))}
      </select>
    );
  };

  return (
    <div className={`sf-section ${disabled ? 'disabled' : ''}`}>
      <div className="h">
        <span className="dot" />
        <span className="tt">Model your data</span>
      </div>

      <div>
        <label>{relEnabled ? `Primary ${noun} (Table 1)` : Noun}</label>
        <ObjectSelect value={tables[0]?.object ?? ''} onChange={setPrimaryObject} />
      </div>

      <label className="switch" style={{ marginTop: 14 }}>
        <input
          type="checkbox"
          checked={relEnabled}
          onChange={(e) => toggleRelationships(e.target.checked)}
          disabled={!tables[0]?.object}
        />
        <span className="track" />
        <span>Combine multiple {nounPlural} (data modeling)</span>
      </label>

      {relEnabled ? (
        <div className="col" style={{ gap: 12, marginTop: 14 }}>
          <div>
            <label>Model type</label>
            <div className="segmented">
              <button type="button" className={mode === 'relationship' ? 'on' : ''} onClick={() => setMode('relationship')}>
                Relationship
              </button>
              <button type="button" className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>
                Join
              </button>
            </div>
            <div className="hint">
              {mode === 'relationship'
                ? `Recommended. ${Noun}s stay separate and are related by cardinality; Tableau chooses the join at query time.`
                : `${Noun}s are flattened into one table using the chosen SQL join type.`}
            </div>
          </div>

          {tables.slice(1).map((t, idx) => {
            const i = idx + 1; // index in `tables`
            const priorObjects = tables.slice(0, i).map((p) => p.object.trim()).filter(Boolean);
            const leftObject = t.rel?.leftObject ?? '';
            return (
              <div key={i} className="tablecard">
                <div className="th">
                  <span className="lbl">
                    <span className="num">{i + 1}</span> Table {i + 1}
                  </span>
                  <button type="button" className="linkbtn" onClick={() => removeTable(i)}>
                    Remove
                  </button>
                </div>
                <div>
                  <label>{Noun}</label>
                  <ObjectSelect value={t.object} onChange={(v) => setTableObject(i, v)} />
                </div>
                <label style={{ marginTop: 10 }}>{mode === 'join' ? 'Join condition' : 'Relationship condition'}</label>
                <div className="joinrow">
                  <select value={leftObject} onChange={(e) => updateRel(i, { leftObject: e.target.value, leftField: '' })}>
                    <option value="">{mode === 'join' ? 'Join to…' : 'Relate to…'}</option>
                    {priorObjects.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <FieldSelect object={leftObject} value={t.rel?.leftField ?? ''} onChange={(v) => updateRel(i, { leftField: v })} />
                  <span className="eq">=</span>
                  <FieldSelect object={t.object} value={t.rel?.rightField ?? ''} onChange={(v) => updateRel(i, { rightField: v })} />
                </div>
                <div style={{ marginTop: 10 }}>
                  {mode === 'join' ? (
                    <>
                      <label>Join type</label>
                      <select
                        value={t.rel?.joinType ?? 'left'}
                        onChange={(e) => updateRel(i, { joinType: e.target.value as ModelJoinType })}
                      >
                        {JOIN_TYPE_OPTIONS.map((j) => (
                          <option key={j.value} value={j.value}>
                            {j.label}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <>
                      <label>Cardinality</label>
                      <select
                        value={t.rel?.cardinality ?? 'many-to-many'}
                        onChange={(e) => updateRel(i, { cardinality: e.target.value as ModelCardinality })}
                      >
                        {CARDINALITY_OPTIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <button type="button" className="addbtn" onClick={addTable} disabled={!tables[0]?.object}>
            + Add table
          </button>
          {hasDupes ? <div className="warnbox small">Each {noun} can be added only once.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
