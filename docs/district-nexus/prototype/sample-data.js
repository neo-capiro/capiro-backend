/* District Nexus — sample data.
   Districts, members, agencies and Assistance Listing numbers are real (119th Congress).
   Client organizations, facilities, mappings and dollar figures are fictional. */

const FIPS = {'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'};

const SENATORS = {
  VA:[['Mark R. Warner','D'],['Tim Kaine','D']],
  WA:[['Patty Murray','D'],['Maria Cantwell','D']],
  TX:[['John Cornyn','R'],['Ted Cruz','R']],
  GA:[['Jon Ossoff','D'],['Raphael Warnock','D']],
  MI:[['Gary Peters','D'],['Elissa Slotkin','D']],
  PA:[['John Fetterman','D'],['Dave McCormick','R']],
  AZ:[['Mark Kelly','D'],['Ruben Gallego','D']],
  MS:[['Roger Wicker','R'],['Cindy Hyde-Smith','R']],
  ME:[['Susan Collins','R'],['Angus King','I']],
  CA:[['Alex Padilla','D'],['Adam Schiff','D']],
  OH:[['Bernie Moreno','R'],['Jon Husted','R']],
  OR:[['Ron Wyden','D'],['Jeff Merkley','D']],
  KY:[['Mitch McConnell','R'],['Rand Paul','R']],
  WV:[['Shelley Moore Capito','R'],['Jim Justice','R']],
  WY:[['John Barrasso','R'],['Cynthia Lummis','R']],
  MT:[['Steve Daines','R'],['Tim Sheehy','R']],
  NM:[['Martin Heinrich','D'],['Ben Ray Luján','D']]
};

const CLIENTS = [
  {id:'mer', name:'Meridian Aerostructures', short:'Meridian', sector:'Defense manufacturing',
   mappings:{contracting:'confirmed', assistance_recipient:'confirmed'},
   ueis:[{uei:'J4K7QW2N8XM3', name:'MERIDIAN AEROSTRUCTURES INC', state:'GA', confirmed:true}]},
  {id:'cha', name:'Cascade Health Alliance', short:'Cascade', sector:'Nonprofit health system',
   mappings:{contracting:'none', assistance_recipient:'confirmed'},
   ueis:[{uei:'HR3PLM6TCV81', name:'CASCADE HEALTH ALLIANCE', state:'WA', confirmed:true},
         {uei:'QF29NBD4JXL5', name:'CASCADE HEALTH FOUNDATION', state:'WA', confirmed:true}]},
  {id:'tms', name:'Tidewater Marine Systems', short:'Tidewater', sector:'Shipbuilding supply',
   mappings:{contracting:'confirmed', assistance_recipient:'none'},
   ueis:[]},
  {id:'ngu', name:'Northgate University', short:'Northgate', sector:'Public research university',
   mappings:{contracting:'confirmed', assistance_recipient:'confirmed'},
   ueis:[{uei:'W8TG5RKP2ZQ7', name:'NORTHGATE UNIVERSITY', state:'MI', confirmed:true}]},
  {id:'lsg', name:'Lone Star Grid Partners', short:'Lone Star', sector:'Grid infrastructure',
   mappings:{contracting:'none', assistance_recipient:'confirmed'},
   ueis:[{uei:'M6VYD3HN9BK2', name:'LONE STAR GRID PARTNERS LLC', state:'TX', confirmed:true}]},
  {id:'alm', name:'Allegheny Materials', short:'Allegheny', sector:'Advanced materials',
   mappings:{contracting:'confirmed', assistance_recipient:'review'},
   ueis:[]},
  {id:'swa', name:'Sonoran Water Authority', short:'Sonoran', sector:'Municipal water',
   mappings:{contracting:'none', assistance_recipient:'confirmed'},
   ueis:[{uei:'P7XC2LQF4RT9', name:'SONORAN WATER AUTHORITY', state:'AZ', confirmed:true}]},
  {id:'brb', name:'Beacon Rural Broadband', short:'Beacon', sector:'Rural telecommunications',
   mappings:{contracting:'none', assistance_recipient:'confirmed'},
   ueis:[{uei:'B5NW8JHT6DY4', name:'BEACON RURAL BROADBAND COOPERATIVE', state:'MS', confirmed:true}]}
];
const CLIENT_BY_ID = Object.fromEntries(CLIENTS.map(c => [c.id, c]));

/* Each district: verified nexus rows for this firm's book of business.
   emp:null means the client has not reported an employee count (null ≠ 0). */
const DISTRICTS = [
  {k:'VA-02', name:'Virginia 2nd', house:['Jen Kiggans','R','K000399',['Armed Services','Veterans\u2019 Affairs']],
   rows:[{c:'tms', role:'Headquarters and production', fac:2, emp:1240, geocode:'matched'}],
   contracts:{obl:18400000, n:14, basis:'place_of_performance'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:true, note:'Seapower and Projection Forces subcommittee \u2014 client\u2019s primary program line'},
   targets:[{m:'Jen Kiggans', c:'tms', last:'2026-05-14'}],
   acs:{pop:812430, mhi:82409, vet:96180, year:2024}},

  {k:'MS-04', name:'Mississippi 4th', house:['Mike Ezell','R','E000313',['Homeland Security','Transportation and Infrastructure']],
   rows:[{c:'tms', role:'Fabrication yard', fac:1, emp:960, geocode:'matched'}],
   contracts:{obl:31500000, n:9, basis:'place_of_performance'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:753100, mhi:56215, vet:58940, year:2024}},

  {k:'ME-01', name:'Maine 1st', house:['Chellie Pingree','D','P000597',['Appropriations','Agriculture']],
   rows:[{c:'tms', role:'Component supplier site', fac:1, emp:275, geocode:'matched'}],
   contracts:{obl:7800000, n:6, basis:'place_of_performance'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:true, note:'Appropriations \u2014 Defense subcommittee'},
   targets:[{m:'Chellie Pingree', c:'tms', last:'2026-02-03'}],
   acs:{pop:702800, mhi:74350, vet:59120, year:2024}},

  {k:'GA-11', name:'Georgia 11th', house:['Barry Loudermilk','R','L000583',['Financial Services','House Administration']],
   rows:[{c:'mer', role:'Primary assembly plant', fac:1, emp:890, geocode:'matched'}],
   contracts:{obl:22700000, n:11, basis:'place_of_performance'},
   grants:{obl:1850000, outl:940000, n:2, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[{m:'Barry Loudermilk', c:'mer', last:'2026-06-22'}],
   acs:{pop:786400, mhi:88720, vet:44310, year:2024}},

  {k:'CA-27', name:'California 27th', house:['George Whitesides','D','W000829',['Armed Services','Science, Space, and Technology']],
   rows:[{c:'mer', role:'Flight test operations', fac:1, emp:145, geocode:'matched'}],
   contracts:{obl:9300000, n:5, basis:'place_of_performance'},
   grants:{obl:2400000, outl:1120000, n:3, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Armed Services \u2014 Tactical Air and Land Forces'},
   targets:[{m:'George Whitesides', c:'mer', last:'2026-07-09'}],
   acs:{pop:764900, mhi:79180, vet:31640, year:2024}, futureChange:true},

  {k:'TX-12', name:'Texas 12th', house:['Craig Goldman','R','G000605',['Homeland Security','Foreign Affairs']],
   rows:[{c:'mer', role:'Machining and finishing', fac:1, emp:420, geocode:'matched'}],
   contracts:{obl:11200000, n:8, basis:'place_of_performance'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:801200, mhi:74640, vet:48870, year:2024}, futureChange:true},

  {k:'VA-10', name:'Virginia 10th', house:['Suhas Subramanyam','D','S001227',['Oversight and Government Reform','Science, Space, and Technology']],
   rows:[{c:'mer', role:'Engineering center', fac:1, emp:310, geocode:'matched'}],
   contracts:{obl:6200000, n:7, basis:'place_of_performance'},
   grants:{obl:1100000, outl:410000, n:1, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Science, Space, and Technology \u2014 DOE R&D authorization'},
   targets:[{m:'Suhas Subramanyam', c:'mer', last:'2026-04-28'}],
   acs:{pop:823700, mhi:132900, vet:52300, year:2024}},

  {k:'TX-23', name:'Texas 23rd', house:['Tony Gonzales','R','G000594',['Appropriations']],
   rows:[], cAttr:['mer'],
   contracts:{obl:4800000, n:4, basis:'place_of_performance'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:true, note:'Appropriations \u2014 Defense'},
   targets:[{m:'Tony Gonzales', c:'mer', last:'2026-01-17'}],
   acs:{pop:790400, mhi:63180, vet:66200, year:2024}, futureChange:true},

  {k:'WA-07', name:'Washington 7th', house:['Pramila Jayapal','D','J000298',['Judiciary','Education and Workforce']],
   rows:[{c:'cha', role:'Health system headquarters and flagship hospital', fac:3, emp:2150, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:12600000, outl:7340000, n:9, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[{m:'Pramila Jayapal', c:'cha', last:'2026-06-30'}],
   acs:{pop:806100, mhi:121400, vet:33900, year:2024}},

  {k:'WA-09', name:'Washington 9th', house:['Adam Smith','D','S000510',['Armed Services']],
   rows:[{c:'cha', role:'Community clinic network', fac:4, emp:640, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:3400000, outl:2010000, n:4, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:788300, mhi:105600, vet:38200, year:2024}},

  {k:'OR-03', name:'Oregon 3rd', house:['Maxine Dexter','D','D000634',['Natural Resources','Science, Space, and Technology']],
   rows:[{c:'cha', role:'Regional clinic', fac:1, emp:310, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:1250000, outl:600000, n:2, basis:'recipient_location'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:753900, mhi:83100, vet:41700, year:2024}},

  {k:'MI-06', name:'Michigan 6th', house:['Debbie Dingell','D','D000624',['Energy and Commerce']],
   rows:[{c:'ngu', role:'Main campus, medical school, research park', fac:5, emp:4800, geocode:'matched'}],
   contracts:{obl:2100000, n:3, basis:'place_of_performance'},
   grants:{obl:41200000, outl:24800000, n:38, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Energy and Commerce \u2014 Health subcommittee'},
   targets:[{m:'Debbie Dingell', c:'ngu', last:'2026-07-02'}],
   acs:{pop:775200, mhi:86400, vet:31100, year:2024}},

  {k:'PA-17', name:'Pennsylvania 17th', house:['Chris Deluzio','D','D000631',['Armed Services','Veterans\u2019 Affairs']],
   rows:[{c:'alm', role:'Production plant', fac:1, emp:730, geocode:'matched'}],
   contracts:{obl:5500000, n:6, basis:'place_of_performance'},
   grants:{obl:8900000, outl:3200000, n:3, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[{m:'Chris Deluzio', c:'alm', last:'2025-11-19'}],
   acs:{pop:764100, mhi:79800, vet:47300, year:2024}},

  {k:'PA-12', name:'Pennsylvania 12th', house:['Summer Lee','D','L000600',['Oversight and Government Reform']],
   rows:[{c:'alm', role:'R&D laboratory', fac:1, emp:180, geocode:'matched'}],
   contracts:{obl:1400000, n:2, basis:'place_of_performance'},
   grants:{obl:4200000, outl:1800000, n:2, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:752600, mhi:64900, vet:42800, year:2024}},

  {k:'OH-13', name:'Ohio 13th', house:['Emilia Sykes','D','S001222',['Transportation and Infrastructure','Small Business']],
   rows:[{c:'alm', role:'Coating and finishing plant', fac:1, emp:540, geocode:'matched'}],
   contracts:{obl:900000, n:2, basis:'place_of_performance'},
   grants:{obl:2800000, outl:1150000, n:2, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:786800, mhi:63200, vet:52100, year:2024}},

  {k:'AZ-06', name:'Arizona 6th', house:['Juan Ciscomani','R','C001133',['Appropriations']],
   rows:[{c:'swa', role:'Treatment and distribution operations', fac:2, emp:210, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:14300000, outl:5900000, n:5, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Appropriations \u2014 Energy and Water Development'},
   targets:[{m:'Juan Ciscomani', c:'swa', last:'2026-03-11'}],
   acs:{pop:797300, mhi:66800, vet:71400, year:2024}},

  {k:'AZ-07', name:'Arizona 7th', house:['Adelita Grijalva','D','G000601',['Natural Resources']],
   rows:[{c:'swa', role:'Service area, pumping stations', fac:1, emp:85, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:6700000, outl:2400000, n:3, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Natural Resources \u2014 Water, Wildlife and Fisheries'},
   targets:[],
   acs:{pop:779100, mhi:52400, vet:54600, year:2024}},

  {k:'TX-31', name:'Texas 31st', house:['John Carter','R','C001051',['Appropriations']],
   rows:[{c:'lsg', role:'Grid operations center', fac:1, emp:260, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:3100000, outl:980000, n:2, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Appropriations \u2014 Energy and Water Development'},
   targets:[],
   acs:{pop:811500, mhi:88100, vet:73900, year:2024}, futureChange:true},

  {k:'TX-10', name:'Texas 10th', house:['Michael McCaul','R','M001157',['Foreign Affairs','Homeland Security']],
   rows:[{c:'lsg', role:'Substation maintenance depot', fac:1, emp:null, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:1600000, outl:420000, n:1, basis:'recipient_location'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:806200, mhi:82600, vet:48300, year:2024}, futureChange:true},

  {k:'MS-02', name:'Mississippi 2nd', house:['Bennie Thompson','D','T000193',['Homeland Security']],
   rows:[{c:'brb', role:'Network operations and field depot', fac:2, emp:140, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:22400000, outl:8100000, n:4, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[{m:'Bennie Thompson', c:'brb', last:'2026-05-06'}],
   acs:{pop:748900, mhi:44300, vet:48200, year:2024}},

  {k:'KY-05', name:'Kentucky 5th', house:['Harold Rogers','R','R000395',['Appropriations']],
   rows:[{c:'brb', role:'Field depot', fac:1, emp:95, geocode:'matched'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:18100000, outl:6300000, n:3, basis:'place_of_performance'},
   policy:{jurisdiction:true, note:'Appropriations \u2014 Commerce, Justice, Science'},
   targets:[{m:'Harold Rogers', c:'brb', last:'2026-04-02'}],
   acs:{pop:721400, mhi:41800, vet:52700, year:2024}},

  {k:'WV-02', name:'West Virginia 2nd', house:['Riley Moore','R','M001220',['Appropriations']],
   rows:[{c:'brb', role:'Field depot', fac:1, emp:60, geocode:'ambiguous'}],
   contracts:{obl:0, n:0, basis:null},
   grants:{obl:9600000, outl:3100000, n:2, basis:'place_of_performance'},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:900300, mhi:58900, vet:76400, year:2024}},

  {k:'WY-00', name:'Wyoming At-Large', house:['Harriet Hageman','R','H001096',['Judiciary','Natural Resources']],
   rows:[], cAttr:['alm'],
   contracts:{obl:1200000, n:2, basis:'recipient_location'},
   grants:{obl:0, outl:0, n:0, basis:null},
   policy:{jurisdiction:false},
   targets:[],
   acs:{pop:584100, mhi:72500, vet:47900, year:2024},
   note:'Only evidence is recipient headquarters location \u2014 no verified place of performance.'}
];

/* Awarded federal assistance (USAspending 02/03/04/05). Real agencies + Assistance Listing numbers. */
const AWARDS = [
  {fain:'1R01AI170884-01', d:'MI-06', c:'ngu', agency:'Health and Human Services', sub:'National Institutes of Health', aln:'93.855', alnT:'Allergy, Immunology and Transplantation Research', type:'04', typeL:'Project Grant', obl:4820000, outl:2910000, start:'2024-09-01', end:'2029-08-31', basis:'place_of_performance', vintage:'original'},
  {fain:'2340118', d:'MI-06', c:'ngu', agency:'National Science Foundation', sub:'Directorate for Engineering', aln:'47.041', alnT:'Engineering', type:'04', typeL:'Project Grant', obl:3150000, outl:1740000, start:'2024-07-15', end:'2028-06-30', basis:'place_of_performance', vintage:'original'},
  {fain:'DE-EE0010992', d:'PA-17', c:'alm', agency:'Energy', sub:'Office of Energy Efficiency and Renewable Energy', aln:'81.087', alnT:'Renewable Energy Research and Development', type:'04', typeL:'Project Grant', obl:6400000, outl:2100000, start:'2025-01-10', end:'2028-12-31', basis:'place_of_performance', vintage:'original'},
  {fain:'ED25AZE0043', d:'AZ-06', c:'swa', agency:'Environmental Protection Agency', sub:'Office of Water', aln:'66.468', alnT:'Capitalization Grants for Drinking Water State Revolving Funds', type:'02', typeL:'Block Grant', obl:9200000, outl:3800000, start:'2025-03-01', end:'2029-02-28', basis:'place_of_performance', vintage:'original'},
  {fain:'RUS-BB-2024-0117', d:'MS-02', c:'brb', agency:'Agriculture', sub:'Rural Utilities Service', aln:'10.760', alnT:'Water and Waste Disposal Systems for Rural Communities', type:'04', typeL:'Project Grant', obl:12800000, outl:4600000, start:'2024-10-01', end:'2029-09-30', basis:'place_of_performance', vintage:'original'},
  {fain:'NT25BB0009', d:'KY-05', c:'brb', agency:'Commerce', sub:'National Telecommunications and Information Administration', aln:'11.307', alnT:'Economic Adjustment Assistance', type:'04', typeL:'Project Grant', obl:11400000, outl:3900000, start:'2025-02-14', end:'2028-02-13', basis:'place_of_performance', vintage:'original'},
  {fain:'6H79SM088412', d:'WA-07', c:'cha', agency:'Health and Human Services', sub:'Substance Abuse and Mental Health Services Administration', aln:'93.243', alnT:'Substance Abuse and Mental Health Services \u2014 Projects of Regional and National Significance', type:'04', typeL:'Project Grant', obl:5100000, outl:3400000, start:'2024-09-30', end:'2027-09-29', basis:'place_of_performance', vintage:'original'},
  {fain:'FA9550-25-1-0188', d:'CA-27', c:'mer', agency:'Defense', sub:'Air Force Office of Scientific Research', aln:'12.800', alnT:'Air Force Defense Research Sciences Program', type:'04', typeL:'Project Grant', obl:2400000, outl:1120000, start:'2025-04-01', end:'2028-03-31', basis:'place_of_performance', vintage:'original'},
  {fain:'DE-EE0011455', d:'TX-31', c:'lsg', agency:'Energy', sub:'Grid Deployment Office', aln:'81.086', alnT:'Conservation Research and Development', type:'05', typeL:'Cooperative Agreement', obl:3100000, outl:980000, start:'2025-06-01', end:'2029-05-31', basis:'place_of_performance', vintage:'original'},
  {fain:'EDA-2025-DAA-0231', d:'OH-13', c:'alm', agency:'Commerce', sub:'Economic Development Administration', aln:'11.307', alnT:'Economic Adjustment Assistance', type:'04', typeL:'Project Grant', obl:2800000, outl:1150000, start:'2025-05-12', end:'2028-05-11', basis:'place_of_performance', vintage:'original'}
];

/* Awarded assistance that CANNOT be placed in a single district. Never allocated to the map. */
const UNPLACED = [
  {fain:'DE-EE0011090', c:'lsg', agency:'Energy', sub:'Grid Deployment Office', aln:'81.086', obl:5400000, code:'90', state:'TX', reason:'Statewide (code 90) \u2014 place of performance spans multiple districts'},
  {fain:'6U1CMS331771', c:'cha', agency:'Health and Human Services', sub:'Centers for Medicare & Medicaid Services', aln:'93.634', obl:2250000, code:null, state:'WA', reason:'No place of performance reported'},
  {fain:'2418803', c:'ngu', agency:'National Science Foundation', sub:'Directorate for STEM Education', aln:'47.076', obl:1180000, code:'ZZ', state:null, reason:'Undefined district code (ZZ)'},
  {fain:'NT25BB0031', c:'brb', agency:'Commerce', sub:'National Telecommunications and Information Administration', aln:'11.307', obl:3900000, code:'90', state:'MS', reason:'Statewide (code 90) \u2014 place of performance spans multiple districts'}
];

const UNPLACED_CONTRACTS = [
  {piid:'N0002425C4417', c:'tms', agency:'Defense', obl:2600000, code:'90', state:'VA', reason:'Statewide (code 90)'},
  {piid:'FA860125C0083', c:'mer', agency:'Defense', obl:1400000, code:null, state:'CA', reason:'No place of performance reported'}
];

/* Grants.gov opportunities. NOT awarded money. */
const OPPS = [
  {num:'DE-FOA-0003518', title:'Grid Resilience and Innovation Partnerships \u2014 Transmission Modernization', agency:'Energy', aln:'81.087', doc:'synopsis', close:'2026-09-18', ceiling:25000000, floor:2000000, est:180000000, awards:9,
   client:'lsg', rel:78, elig:'needs_review', geo:'TX, OK, NM \u2014 ERCOT and SPP footprints', signals:['Assistance Listing 81.087 matches 2 prior awards','Applicant type: for-profit organizations','Geographic restriction overlaps 3 client facilities']},
  {num:'PAR-26-114', title:'Clinical and Translational Science Award Program', agency:'Health and Human Services', aln:'93.350', doc:'synopsis', close:null, closeDesc:'Continuous \u2014 standard NIH due dates', ceiling:null, floor:null, est:null, awards:null,
   client:'ngu', rel:71, elig:'eligible', geo:null, signals:['Applicant type: public/state institutions of higher education','Client holds 12 active NIH awards','No geographic restriction']},
  {num:'RUS-26-BB-01', title:'ReConnect Loan and Grant Program \u2014 Round 7', agency:'Agriculture', aln:'10.760', doc:'forecast', close:'2026-11-04', ceiling:50000000, floor:5000000, est:700000000, awards:null,
   client:'brb', rel:84, elig:'needs_review', geo:'Eligible rural service areas only', signals:['Assistance Listing 10.760 matches 1 prior award','Forecast \u2014 terms may change before posting','Service-area eligibility not yet verified']},
  {num:'EPA-OW-2026-04', title:'Water Infrastructure Improvements for the Nation \u2014 Small and Disadvantaged Communities',  agency:'Environmental Protection Agency', aln:'66.468', doc:'synopsis', close:'2026-08-29', ceiling:8000000, floor:500000, est:45000000, awards:12,
   client:'swa', rel:66, elig:'needs_review', geo:'Nationwide', signals:['Assistance Listing 66.468 matches 1 prior award','Applicant type: public water systems','Cost sharing required \u2014 20%']},
  {num:'NSF 26-529', title:'Future Manufacturing',  agency:'National Science Foundation', aln:'47.041', doc:'synopsis', close:'2026-10-15', ceiling:4000000, floor:null, est:32000000, awards:8,
   client:'alm', rel:52, elig:'unknown', geo:null, signals:['Assistance Listing 47.041 matches 0 prior awards','Eligibility text requires review \u2014 IHE lead may be required']}
];

const FRESHNESS = [
  {rail:'Client facilities and geocoding', job:'geocode-facilities', at:'2026-07-25T04:15Z', ok:true},
  {rail:'Federal contract awards (DoD prime only)', job:'sync-federal-award', at:'2026-07-25T09:50Z', ok:true},
  {rail:'Federal assistance awards', job:'sync-federal-assistance-awards', at:'2026-07-25T07:45Z', ok:true},
  {rail:'Grant opportunities', job:'sync-grants', at:'2026-07-25T10:00Z', ok:true},
  {rail:'District metadata (LegiStorm)', job:'sync-legistorm-districts', at:'2026-07-19T04:00Z', ok:true},
  {rail:'District demographics (ACS 5-year 2024)', job:'sync-census', at:'2026-07-01T06:00Z', ok:true},
  {rail:'Boundary artifact (Census cartographic, 119th)', job:'build-district-boundary-artifacts', at:'2026-07-20T02:10Z', ok:true},
  {rail:'Members of Congress', job:'sync-congress-members', at:'2026-07-24T05:30Z', ok:true}
];

/* Assistance-recipient resolution queue (§7-B4). Name similarity is a candidate only. */
const RESOLUTION_QUEUE = [
  {uei:'K2QB7VNX9DM4', name:'ALLEGHENY MATERIALS TECHNOLOGIES INC', parent:'ALLEGHENY MATERIALS HOLDINGS LLC', state:'PA', awards:6, obl:15900000, client:'alm', conf:0.91, method:'name_similarity', status:'review'},
  {uei:'T8RJ3WPC5LK6', name:'ALLEGHENY MATERIALS SERVICES LLC', parent:'ALLEGHENY MATERIALS HOLDINGS LLC', state:'OH', awards:2, obl:2800000, client:'alm', conf:0.88, method:'name_similarity', status:'review'},
  {uei:'V4HN6ZTQ2XB8', name:'TIDEWATER MARINE SERVICES OF LOUISIANA', parent:null, state:'LA', awards:3, obl:4100000, client:'tms', conf:0.83, method:'name_similarity', status:'review'},
  {uei:'C9MK4LFD7RW2', name:'NORTHGATE UNIVERSITY FOUNDATION', parent:'NORTHGATE UNIVERSITY', state:'MI', awards:11, obl:8700000, client:'ngu', conf:0.86, method:'name_similarity', status:'review'}
];
