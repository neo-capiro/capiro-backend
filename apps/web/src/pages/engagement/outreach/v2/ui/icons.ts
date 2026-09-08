// Handover §5.4 names `untitledui/engagement-icons.js` — that package doesn't
// exist (the "Untitled UI PRO kit" this repo has is Figma design files only,
// no code). `lucide-react` is already a repo dependency used throughout
// vnext/pages/**, so this maps the handover's exact icon list onto the
// closest lucide-react equivalent instead of hand-drawing a new SVG set.
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  DollarSign,
  Edit2,
  Eye,
  Undo2,
  FileText,
  Globe,
  Info,
  Landmark,
  Lightbulb,
  List,
  Link,
  Mail,
  Paperclip,
  Plus,
  RefreshCcw,
  Search,
  Send,
  Star,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react';

export const Icon = {
  ArrowRight,
  Bell01: Bell,
  Check,
  CheckCircle01: CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit01: Edit2,
  Eye,
  FlipBackward: Undo2,
  // Not in the handover's §5.4 icon list (that capture never hit a "Shared /
  // all recipients" state) — added because Context Plan's Shared scope
  // needs a globe, and lucide-react is the icon source for everything else.
  Globe01: Globe,
  LayoutAlt01: List,
  Link01: Link,
  Plus,
  // Context Builder tab icons — also not in §5.4 (that capture's tab set —
  // Bills/Intel/Emails/Meetings/Docs/Debriefs/Preps — differs from the
  // current app's real tabs: bill/stateBill/programElement/email/prep/
  // debrief/document/note). No handover mapping exists for these; picked
  // for straightforward semantic fit the same way the rest of this file was.
  Bill: FileText,
  StateBill: Landmark,
  ProgramElement: DollarSign,
  Email: Mail,
  Prep: Lightbulb,
  Debrief: ClipboardCheck,
  Document: Paperclip,
  Capability: Cpu,
  // Generate & Review's stale-context banner + draft-status alerts — same
  // "no handover mapping, picked for fit" situation as the tab icons above.
  Zap,
  AlertTriangle,
  AlertCircle,
  Info,
  RefreshCcw02: RefreshCcw,
  SearchLg: Search,
  Send01: Send,
  Star01: Star,
  Stars02: Sparkles,
  Trash01: Trash2,
  User01: User,
  Users01: Users,
  XClose: X,
} as const;
