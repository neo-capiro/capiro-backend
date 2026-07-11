import {
  CalendarOutlined,
  FileTextOutlined,
  RadarChartOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import meriBubbleImage from '../../assets/chat/meri-bubble.png';

const DOCKED_STARTERS = [
  'Summarize today’s intelligence for my clients',
  'Prepare me for my next meeting',
  'Draft a weekly client brief',
] as const;

const UNDOCKED_STARTERS = [
  {
    title: 'Brief me on today',
    prompt: 'Summarize today’s highest-priority intelligence across my clients.',
    icon: <RadarChartOutlined />,
  },
  {
    title: 'Prepare for a meeting',
    prompt: 'Prepare me for my next client or stakeholder meeting.',
    icon: <CalendarOutlined />,
  },
  {
    title: 'Draft a deliverable',
    prompt: 'Help me draft a client-ready weekly brief.',
    icon: <FileTextOutlined />,
  },
  {
    title: 'Review the portfolio',
    prompt: 'Show me which clients need attention and why.',
    icon: <TeamOutlined />,
  },
] as const;

export function MeriEmptyState({
  surface,
  onSend,
}: {
  surface: 'legacy' | 'docked' | 'undocked';
  onSend: (prompt: string) => void;
}) {
  if (surface === 'legacy') {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon" aria-hidden="true">
          ✦
        </div>
        <p className="chat-empty-text">
          Hello! I’m Meri, your workspace assistant. Ask me about your clients, intelligence,
          engagements, or workflows — or ask me to edit a draft.
        </p>
      </div>
    );
  }

  if (surface === 'docked') {
    return (
      <div className="meri-empty meri-empty--docked">
        <span className="meri-empty-avatar">
          <img src={meriBubbleImage} alt="" />
        </span>
        <p>
          <strong>Hello. I’m Meri</strong>, your government-affairs chief of staff. Ask about
          clients, live intelligence, filings, or a client-ready deliverable.
        </p>
        <div className="meri-empty-starters">
          {DOCKED_STARTERS.map((prompt) => (
            <button type="button" key={prompt} onClick={() => onSend(prompt)}>
              <span>{prompt}</span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="meri-empty meri-empty--undocked">
      <span className="meri-empty-avatar">
        <img src={meriBubbleImage} alt="" />
      </span>
      <h2>Good afternoon.</h2>
      <p>I’m tracking your portfolio and live legislative intelligence. What are we working on?</p>
      <div className="meri-empty-cards">
        {UNDOCKED_STARTERS.map((item) => (
          <button type="button" key={item.title} onClick={() => onSend(item.prompt)}>
            <span className="meri-empty-card-icon" aria-hidden="true">
              {item.icon}
            </span>
            <strong>{item.title}</strong>
            <small>{item.prompt}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
