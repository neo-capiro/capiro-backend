import { useLiveHearingRoomController } from './LiveHearingRoomController.js';
import { HearingRoomVNextView } from './HearingRoomVNextView.js';

/** Native vNext presentation over the shared capture and recovery lifecycle. */
export function LiveHearingRoomVNext({ sessionId }: { sessionId: string }) {
  const room = useLiveHearingRoomController({ sessionId, presentation: 'vnext' });
  return <HearingRoomVNextView room={room} />;
}
