export interface PlaybackInterval { startMs: number; endMs: number }

export function hasPlaybackAt(intervals: PlaybackInterval[], positionMs: number): boolean {
  return Number.isFinite(positionMs) && intervals.some((range) =>
    positionMs >= range.startMs && positionMs < range.endMs);
}

/** Transcript completion never implies that retained audio is available. */
export function publicPlaybackCoverage(epochs: Array<{
  state: string; startMs: number; durableEndMs: number; durableBytes: number; expiresAt: string;
}>, now = Date.now()): PlaybackInterval[] {
  return epochs.filter((epoch) => epoch.state !== 'expired' && epoch.durableBytes > 0 &&
    Date.parse(epoch.expiresAt) > now && Number.isFinite(epoch.startMs) &&
    Number.isFinite(epoch.durableEndMs) && epoch.durableEndMs > epoch.startMs)
    .map((epoch) => ({ startMs: epoch.startMs, endMs: epoch.durableEndMs }));
}
