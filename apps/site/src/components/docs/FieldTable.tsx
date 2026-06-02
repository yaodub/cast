import type { ComponentChildren } from 'preact';
import { proseTable, proseTh, proseTd, monoTd, monoTdMuted } from './DocsLayout';

/**
 * FieldTable — the standard config-schema table shared across plugin families
 * (transport route entries, extension config/secrets, profile options).
 *
 * Columns: Field · Type · Default · Effect. A field is rendered as <code>; the
 * Default cell shows the literal default, or `required` when `required: true`
 * and no default is given, or an em-dash otherwise. `effect` is arbitrary
 * children so callers can embed <code>, links, etc.
 *
 * Keeping every family on one component means the field-doc rhythm is identical
 * everywhere and the columns can later be fed straight from a live Zod schema.
 */
export interface Field {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  effect: ComponentChildren;
}

export function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <table style={proseTable}>
      <thead>
        <tr>
          <th style={proseTh}>Field</th>
          <th style={proseTh}>Type</th>
          <th style={proseTh}>Default</th>
          <th style={proseTh}>Effect</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.name}>
            <td style={monoTd}>{f.name}</td>
            <td style={monoTdMuted}>{f.type}</td>
            <td style={f.default !== undefined ? monoTd : proseTd}>
              {f.default !== undefined ? (
                f.default
              ) : f.required ? (
                <span style={{ color: 'var(--fg-muted)' }}>required</span>
              ) : (
                <span style={{ color: 'var(--fg-subtle)' }}>—</span>
              )}
            </td>
            <td style={proseTd}>{f.effect}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
