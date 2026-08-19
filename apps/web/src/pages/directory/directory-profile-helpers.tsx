import type { ReactNode } from 'react';
import { Card, Descriptions, Tag, Typography } from 'antd';
import { hasText } from './directory-profile-shared.js';
import type { OfficeAddress } from './directory-profile-shared.js';

const { Text } = Typography;

// Pure text helpers moved to directory-profile-shared.ts (UI-free) so the
// vNext profile pages can share them; re-exported here so this module's
// public API is unchanged.
export { hasText, NOT_PROVIDED, orNotProvided } from './directory-profile-shared.js';
export type { OfficeAddress } from './directory-profile-shared.js';

/** A label/value pair for a Descriptions grid; dropped entirely when the value is blank. */
export type BioField = { label: string; value: string | null | undefined };

/**
 * A Descriptions card that renders only the fields that actually have a value and
 * disappears entirely when every field is blank — per the "don't show empty fields"
 * directory rule. No "Not provided by source" placeholders.
 */
export function DescriptionsCard({
  title,
  fields,
  column = 2,
}: {
  title: string;
  fields: BioField[];
  column?: number;
}) {
  const present = fields.filter((f) => hasText(f.value));
  if (present.length === 0) return null;
  return (
    <Card size="small" title={title} style={{ marginBottom: 16 }}>
      <Descriptions column={column} size="small">
        {present.map((f) => (
          <Descriptions.Item key={f.label} label={f.label}>
            {f.value}
          </Descriptions.Item>
        ))}
      </Descriptions>
    </Card>
  );
}

/**
 * A card wrapping a list, omitted entirely when the list is empty so sections with no
 * data vanish rather than showing a placeholder. Count is appended to the title.
 */
export function ListCard<T>({
  title,
  items,
  render,
  showCount = true,
}: {
  title: string;
  items: T[] | null | undefined;
  render: (item: T, index: number) => ReactNode;
  showCount?: boolean;
}) {
  if (!items || items.length === 0) return null;
  return (
    <Card size="small" title={showCount ? `${title} (${items.length})` : title} style={{ marginBottom: 16 }}>
      {items.map((item, i) => render(item, i))}
    </Card>
  );
}

/** Render one physical office address, hiding any blank line within it. */
export function renderOfficeAddress(a: OfficeAddress, i: number): ReactNode {
  const cityLine = [a.city, a.state, [a.zip, a.zipExt].filter(Boolean).join('-')]
    .filter(Boolean)
    .join(', ');
  const streetLine = [a.address1, a.address2, cityLine].filter(hasText).join(', ');
  const heading = a.label || a.officeName;
  return (
    <div key={a.addressId ?? i} style={{ marginBottom: 8 }}>
      {(hasText(heading) || a.isMain) && (
        <div>
          {hasText(heading) ? <Text strong>{heading}</Text> : null}{' '}
          {a.isMain ? <Tag color="blue">Main</Tag> : null}
        </div>
      )}
      {hasText(streetLine) ? (
        <div>
          <Text type="secondary">{streetLine}</Text>
        </div>
      ) : null}
      {hasText(a.phone) || hasText(a.fax) ? (
        <div>
          {hasText(a.phone) ? <Text type="secondary">Phone: {a.phone}</Text> : null}
          {hasText(a.fax) ? (
            <Text type="secondary">
              {hasText(a.phone) ? ' · ' : ''}Fax: {a.fax}
            </Text>
          ) : null}
        </div>
      ) : null}
      {hasText(a.publicNotes) ? (
        <div>
          <Text type="secondary">{a.publicNotes}</Text>
        </div>
      ) : null}
    </div>
  );
}
