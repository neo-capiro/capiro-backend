import {
  App as AntApp,
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
  Typography,
} from 'antd';
import { ArrowLeftOutlined, AudioOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { HearingPublicationsPanel } from './HearingPublicationsPanel.js';
import { HearingPublishedRecordsPanel } from './HearingPublishedRecordsPanel.js';
import '../radar/legiwatch.css';
import { createHearingRoomComponents } from './HearingRoomComposition.js';
export type { HearingRoomViewModel } from './HearingRoomComposition.js';
export const { LiveHearingRoomPage, TranscriptList, SaveRecapModal } = createHearingRoomComponents({
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
  Typography,
  ArrowLeftOutlined,
  AudioOutlined,
  ReloadOutlined,
  SaveOutlined,
  HearingPublicationsPanel,
  HearingPublishedRecordsPanel,
  useNotifications: () => AntApp.useApp(),
});
export default LiveHearingRoomPage;
