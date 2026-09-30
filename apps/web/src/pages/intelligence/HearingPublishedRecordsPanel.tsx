import '../../vnext/pages/legiwatch/hearings/hearing-published-records.css';
// The records panel renders HearingSmsSetup, which is styled by the publications
// sheet; before the Core split this module loaded it through its
// HearingPublicationsPanel import.
import '../../vnext/pages/legiwatch/hearings/hearing-publications.css';
export { HearingPublishedRecordsPanel } from './HearingPublishedRecordsPanelCore.js';
