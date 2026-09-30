import type { ComponentProps } from 'react';
import { PublicHearingReviewPanel as ReviewCore } from '../../../../pages/intelligence/PublicHearingReviewPanelCore.js';
import { HearingPublishedRecordsPanel as RecordsCore } from '../../../../pages/intelligence/HearingPublishedRecordsPanelCore.js';
import {
  HearingPublicationsPanel as PublicationsCore,
  HearingSmsSetup as SmsCore,
} from '../../../../pages/intelligence/HearingPublicationsPanelCore.js';
import './hearing-review-native.css';

export function PublicHearingReviewPanel(props: ComponentProps<typeof ReviewCore>) {
  return (
    <div className="lw-native-review">
      <ReviewCore {...props} />
    </div>
  );
}

export function HearingPublishedRecordsPanel(props: ComponentProps<typeof RecordsCore>) {
  return (
    <div className="lw-native-review">
      <RecordsCore {...props} />
    </div>
  );
}

export function HearingPublicationsPanel(props: ComponentProps<typeof PublicationsCore>) {
  return (
    <div className="lw-native-review">
      <PublicationsCore {...props} />
    </div>
  );
}

export function HearingSmsSetup(props: ComponentProps<typeof SmsCore>) {
  return (
    <div className="lw-native-review">
      <SmsCore {...props} />
    </div>
  );
}
