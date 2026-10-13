"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.US_STATE_BY_ABBR = void 0;
exports.resolveUsStateCode = resolveUsStateCode;
exports.US_STATE_BY_ABBR = {
    AL: 'Alabama',
    AK: 'Alaska',
    AZ: 'Arizona',
    AR: 'Arkansas',
    CA: 'California',
    CO: 'Colorado',
    CT: 'Connecticut',
    DE: 'Delaware',
    FL: 'Florida',
    GA: 'Georgia',
    HI: 'Hawaii',
    ID: 'Idaho',
    IL: 'Illinois',
    IN: 'Indiana',
    IA: 'Iowa',
    KS: 'Kansas',
    KY: 'Kentucky',
    LA: 'Louisiana',
    ME: 'Maine',
    MD: 'Maryland',
    MA: 'Massachusetts',
    MI: 'Michigan',
    MN: 'Minnesota',
    MS: 'Mississippi',
    MO: 'Missouri',
    MT: 'Montana',
    NE: 'Nebraska',
    NV: 'Nevada',
    NH: 'New Hampshire',
    NJ: 'New Jersey',
    NM: 'New Mexico',
    NY: 'New York',
    NC: 'North Carolina',
    ND: 'North Dakota',
    OH: 'Ohio',
    OK: 'Oklahoma',
    OR: 'Oregon',
    PA: 'Pennsylvania',
    RI: 'Rhode Island',
    SC: 'South Carolina',
    SD: 'South Dakota',
    TN: 'Tennessee',
    TX: 'Texas',
    UT: 'Utah',
    VT: 'Vermont',
    VA: 'Virginia',
    WA: 'Washington',
    WV: 'West Virginia',
    WI: 'Wisconsin',
    WY: 'Wyoming',
    DC: 'District of Columbia',
    PR: 'Puerto Rico',
    GU: 'Guam',
    VI: 'Virgin Islands',
    AS: 'American Samoa',
    MP: 'Northern Mariana Islands',
};
/** Normalize either the roster's full state name or a facility's postal code. */
function resolveUsStateCode(value) {
    const input = value?.trim().toUpperCase();
    if (!input)
        return undefined;
    if (Object.prototype.hasOwnProperty.call(exports.US_STATE_BY_ABBR, input))
        return input;
    return Object.entries(exports.US_STATE_BY_ABBR).find(([, name]) => name.toUpperCase() === input)?.[0];
}
//# sourceMappingURL=us-states.js.map