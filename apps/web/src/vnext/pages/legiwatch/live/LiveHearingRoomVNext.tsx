import { LiveHearingRoomPage } from '../../../../pages/intelligence/LiveHearingRoomPage.js';

/** Keep browser capture, consent, playback and transcript recovery on the same
 * tested room as the canonical route. A second socket-only presentation cannot
 * start tab recording and must not advertise an active capture. */
export function LiveHearingRoomVNext({ sessionId }: { sessionId: string }) {
  return <LiveHearingRoomPage key={sessionId} sessionId={sessionId} presentation="vnext" />;
}
