import { Avatar } from 'antd';

/** First letters of the first two name words; safe for empty/single-word names. */
export function personInitials(name: string): string {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface DirectoryProfilePhotoProps {
  url: string | null;
  name: string;
  size?: number;
}

/**
 * Real photo when available, initials otherwise — AntD Avatar falls back to the
 * children on a missing/broken src (onError) with no layout shift (fixed size).
 * A staffer is never given a member's photo; callers pass the resolved url/null.
 */
export function DirectoryProfilePhoto({ url, name, size = 96 }: DirectoryProfilePhotoProps) {
  return (
    <Avatar
      src={url || undefined}
      size={size}
      shape="square"
      alt={name}
      className="directory-profile-photo"
      style={{ backgroundColor: '#1f3a5f', flexShrink: 0 }}
    >
      {personInitials(name)}
    </Avatar>
  );
}
