import { LiveHearingRoomPage } from '../../../../pages/intelligence/LiveHearingRoomPage.js';
import { HearingRoomVNextView } from './HearingRoomVNextView.js';

/** Native vNext presentation over the shared capture and recovery lifecycle. */
export function LiveHearingRoomVNext({ sessionId }: { sessionId: string }) {
  return <LiveHearingRoomPage key={sessionId} sessionId={sessionId} presentation="vnext"
    renderRoom={(room) => <HearingRoomVNextView room={room} />} />;
}
