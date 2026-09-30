import {
  type ReactNode,
  type CSSProperties,
  type ButtonHTMLAttributes,
  createElement,
  useState,
} from 'react';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { createHearingRoomComponents } from '../../../../pages/intelligence/HearingRoomComposition.js';
import type { HearingRoomUi } from '../../../../pages/intelligence/HearingRoomComposition.js';
import {
  HearingPublicationsPanel,
  HearingPublishedRecordsPanel,
} from '../hearings/HearingReviewPanelsVNext.js';
import { HearingRoomVNextView } from './HearingRoomVNextView.js';
import './save-recap-modal.css';

type ContentProps = {
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  type?: string;
  strong?: boolean;
  code?: boolean;
  level?: number;
};
function Text({ children, strong, code, style, className }: ContentProps) {
  return (
    <span style={style} className={className}>
      {code ? <code>{children}</code> : strong ? <strong>{children}</strong> : children}
    </span>
  );
}
function Title({ children, level = 2, style }: ContentProps) {
  return createElement(`h${level}`, { style }, children);
}
function Paragraph({ children, style }: ContentProps) {
  return <p style={style}>{children}</p>;
}
function Button({
  type,
  loading,
  disabled,
  icon,
  size: _size,
  danger: _danger,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  type?: string;
  loading?: boolean;
  icon?: ReactNode;
  size?: string;
  danger?: boolean;
}) {
  return (
    <CapiroButton
      variant={type === 'primary' ? 'primary' : 'secondary'}
      disabled={disabled || loading}
      {...props}
    >
      {icon}
      {props.children}
    </CapiroButton>
  );
}
function Modal({
  open,
  title,
  onCancel,
  width,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  width?: number;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <CapiroModal open={open} title={title} onClose={onCancel} width={width}>
      <div className="lw-native-recap">
        {children}
        <div className="lw-recap-actions">{footer}</div>
      </div>
    </CapiroModal>
  );
}
function Select({
  value,
  options,
  onChange,
  placeholder,
  style,
  showSearch,
  'aria-label': label,
}: {
  value?: string;
  options: Array<{ value: string; label: ReactNode }>;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  showSearch?: boolean;
  'aria-label'?: string;
}) {
  const [search, setSearch] = useState('');
  const visible = options.filter(
    (option) =>
      option.value === value || String(option.label).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div>
      {showSearch ? (
        <input
          type="search"
          aria-label={`Search ${label?.toLowerCase() ?? 'options'}`}
          placeholder="Search clients"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        style={style}
      >
        <option value="">{placeholder}</option>
        {visible.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
function Alert({
  message,
  description,
  action,
  type,
  style,
  onClose,
  closable,
}: {
  message?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  type?: string;
  style?: CSSProperties;
  onClose?: () => void;
  closable?: boolean;
}) {
  return (
    <div
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      className="lw-recap-notice"
      style={style}
    >
      <strong>{message}</strong>
      {description ? <p>{description}</p> : null}
      {action}
      {closable ? (
        <button onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}
function Space({
  children,
  direction,
  size = 8,
  wrap,
  style,
}: ContentProps & { direction?: string; size?: number; wrap?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction === 'vertical' ? 'column' : 'row',
        gap: size,
        flexWrap: wrap ? 'wrap' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
function Card({
  children,
  title,
  extra,
  style,
}: ContentProps & { title?: ReactNode; extra?: ReactNode }) {
  return (
    <section style={style}>
      {title ? (
        <header>
          {title}
          {extra}
        </header>
      ) : null}
      {children}
    </section>
  );
}
function Divider({ style }: ContentProps) {
  return <hr style={style} />;
}
function Empty({ description }: { description?: ReactNode }) {
  return <p>{description ?? 'No data'}</p>;
}
function Spin() {
  return <span role="status">Loading…</span>;
}
function Tag({ children }: ContentProps) {
  return <span className="lw-recap-tag">{children}</span>;
}
function Tooltip({ children, title }: ContentProps & { title?: string }) {
  return <span title={title}>{children}</span>;
}
function Badge({ text, children }: ContentProps & { text?: ReactNode }) {
  return (
    <span>
      {text}
      {children}
    </span>
  );
}
function NoIcon() {
  return null;
}
const ui = {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography: { Title, Text, Paragraph },
  ArrowLeftOutlined: NoIcon,
  AudioOutlined: NoIcon,
  ReloadOutlined: NoIcon,
  SaveOutlined: NoIcon,
  HearingPublicationsPanel,
  HearingPublishedRecordsPanel,
  useNotifications: () => {
    const toast = useCapiroToast();
    return {
      message: {
        success: (text: string) => toast.success(text),
        error: (text: string) => toast.error(text),
      },
    };
  },
} as unknown as HearingRoomUi;
const nativeRoom = createHearingRoomComponents(ui);
export const SaveRecapModalVNext = nativeRoom.SaveRecapModal;
export function LiveHearingRoomVNext({ sessionId }: { sessionId: string }) {
  return (
    <nativeRoom.LiveHearingRoomPage
      key={sessionId}
      sessionId={sessionId}
      presentation="vnext"
      renderRoom={(room) => <HearingRoomVNextView room={room} />}
    />
  );
}
