| element | prototype | implementation | Δw | Δh | verdict |
| --- | --- | --- | --- | --- | --- |
| `header` | 1440x900 @ 0,0 | 1208x130.29 @ 232,54 | -232 | -769.71 | FAIL |
| `headerEyebrow` | 770x13.33 @ 300,66 | 1114x15.71 @ 300,66 | 344 | 2.38 | FAIL |
| `headerTitle` | 289.77x16.67 @ 329.21,18.33 | 1114x26.4 @ 300,81.71 | 824.23 | 9.73 | FAIL |
| `layerChipPpbe` | 63.85x26 @ 306.18,137.25 | 63.85x26 @ 306.18,139.63 | 0.0 | 0 | PASS |
| `layerChipCongress` | 86.06x26 @ 378.03,137.25 | 86.06x26 @ 378.03,139.63 | 0.0 | 0 | PASS |
| `watchChip` | 110.43x26.67 @ 771.91,136.92 | 110.43x26.67 @ 1115.91,139.29 | 0.0 | 0.0 | PASS |
| `exportBtn` | 84.43x34 @ 890.33,133.25 | 84.43x34 @ 1234.33,135.63 | 0.0 | 0 | PASS |
| `historyBtn` | 87.24x34 @ 982.76,133.25 | 87.24x34 @ 1326.76,135.63 | 0.0 | 0 | PASS |
| `composerInput` | 199.67x17.5 @ 1146,768.25 | 199.67x17.5 @ 1146,1210.29 | 0.0 | 0.0 | PASS |
| `composerBox` | 315.33x48.67 @ 1110.67,752.67 | 315.33x48.67 @ 1110.67,1194.71 | 0.0 | 0.0 | PASS |
| `panel` | 343.33x159 @ 1096.67,741 | 343.33x159 @ 1096.67,1183.04 | 0.0 | 0 | PASS |
| `suggestionPill` | 151.48x24.67 @ 1110.67,810.33 | 151.48x24.67 @ 1110.67,1252.38 | 0.0 | 0.0 | PASS |
| `watchCardList` | 298.67x372 @ 1114,173 | 308.67x372 @ 1114,371.29 | 10.0 | 0 | FAIL |
| `acceptBtn` | 60.57x26.67 @ 1137.67,442.96 | 60.57x26.67 @ 1137.67,624 | 0.0 | 0.0 | PASS |
| `dismissBtn` | 55.39x24.67 @ 1204.24,443.96 | 55.39x24.67 @ 1204.24,625 | 0.0 | 0.0 | PASS |
| `whyBtn` | 25.79x13.33 @ 1353.21,603.96 | 25.79x13.33 @ 1363.21,785 | 0.0 | 0.0 | PASS |
| `acceptAllBtn` | 75.13x24.67 @ 1126,565.67 | 75.13x24.67 @ 1126,763.96 | 0.0 | 0.0 | PASS |
| `pauseBtn` | 122.5x24.67 @ 1208.13,565.67 | 122.5x24.67 @ 1208.13,763.96 | 0.0 | 0.0 | PASS |

**Geometry: 14/18 within ±1 CSS px.**

### Computed-style differences

| element | property | prototype | implementation |
| --- | --- | --- | --- |
| `header` | padding | `0px` | `12px 26px 14px` |
| `header` | borderBottomWidth | `0px` | `0.666667px` |
| `header` | backgroundColor | `rgb(244, 242, 236)` | `rgb(255, 255, 255)` |
| `header` | flexShrink | `1` | `0` |
| `headerEyebrow` | lineHeight | `normal` | `15.7143px` |
| `headerTitle` | fontSize | `12.5px` | `22px` |
| `headerTitle` | fontWeight | `600` | `700` |
| `headerTitle` | lineHeight | `normal` | `26.4px` |
| `headerTitle` | letterSpacing | `normal` | `-0.44px` |
| `headerTitle` | whiteSpace | `normal` | `nowrap` |
| `headerTitle` | overflow | `visible` | `hidden` |
| `headerTitle` | textOverflow | `clip` | `ellipsis` |
| `panel` | width | `343.333px` | `315.333px` |
| `panel` | boxSizing | `border-box` | `content-box` |

### Unverified (locator matched nothing on one side — NOT a pass)

- `headerGoal` — missing/zero-size on the prototype (zero-size match)
- `headerGoalTitleAttr` — missing/zero-size on the prototype
- `askMeriBtn` — missing/zero-size on the prototype
- `headerRow2Order` — missing/zero-size on the prototype
- `frozenLabelCol` — missing/zero-size on the prototype
- `todayFlag` — missing/zero-size on the prototype (zero-size match)
- `horizontalScrollers` — missing/zero-size on the prototype
- `strategyLaneLabel` — missing/zero-size on the prototype (zero-size match)
- `draftedNote` — missing/zero-size on the prototype (zero-size match)
- `panelHeaderSub` — missing/zero-size on the prototype (zero-size match)
- `userBubble` — missing/zero-size on the prototype
- `meriBubble` — missing/zero-size on the prototype
- `attachmentChip` — missing/zero-size on the prototype
- `watchStatusLabel` — missing/zero-size on the implementation
- `watchBlock` — missing/zero-size on the implementation
- `proposalCard` — missing/zero-size on the prototype
- `proposalTitle` — missing/zero-size on the prototype (zero-size match)
- `proposalBody` — missing/zero-size on the prototype (zero-size match)
- `outOfOrderBadge` — missing/zero-size on the implementation
- `whyExpansion` — missing/zero-size on the prototype (zero-size match)
- `watchFooterNote` — missing/zero-size on the prototype (zero-size match)
- `recheckingVisible` — missing/zero-size on the prototype
- `contextGapMessage` — missing/zero-size on the prototype
- `needsContextMarker` — missing/zero-size on the prototype
- `needsContextCount` — missing/zero-size on the prototype

### Document-level overflow

- prototype: {"scrollWidth": 1440, "clientWidth": 1440, "horizontalOverflow": false}
- implementation: {"scrollWidth": 1440, "clientWidth": 1440, "horizontalOverflow": false}
