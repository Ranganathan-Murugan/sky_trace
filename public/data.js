/* Offline reference tables. The free ADS-B feeds give us a callsign, a tail
 * number and an ICAO type code - these turn that into human readable text
 * without any extra network calls. */

// Callsign prefix (ICAO airline designator) -> { name, country }
const AIRLINES = {
  AAL:['American Airlines','US','AA'], ACA:['Air Canada','CA','AC'], AFL:['Aeroflot','RU','SU'], AFR:['Air France','FR','AF'],
  AIC:['Air India','IN','AI'], AIZ:['Arkia','IL'], ANA:['All Nippon Airways','JP','NH'], ANZ:['Air New Zealand','NZ','NZ'],
  ASA:['Alaska Airlines','US','AS'], AUA:['Austrian Airlines','AT','OS'], AAR:['Asiana Airlines','KR','OZ'],
  AZA:['ITA Airways','IT','AZ'], AEE:['Aegean Airlines','GR','A3'], AXM:['AirAsia','MY','AK'], AWE:['America West','US'],
  BAW:['British Airways','GB','BA'], BEL:['Brussels Airlines','BE','SN'], BER:['Air Berlin','DE','AB'], BOX:['AeroLogic','DE'],
  BAV:['Bravo Airways','UA'], BTI:['Air Baltic','LV','BT'], CAL:['China Airlines','TW','CI'], CCA:['Air China','CN','CA'],
  CES:['China Eastern','CN','MU'], CSN:['China Southern','CN','CZ'], CFG:['Condor','DE','DE'], CPA:['Cathay Pacific','HK','CX'],
  CSA:['Czech Airlines','CZ','OK'], CTN:['Croatia Airlines','HR','OU'], CYP:['Cyprus Airways','CY','CY'],
  DAL:['Delta Air Lines','US','DL'], DLH:['Lufthansa','DE','LH'], EDW:['Edelweiss Air','CH','WK'], EIN:['Aer Lingus','IE','EI'],
  ELY:['El Al','IL','LY'], ETD:['Etihad Airways','AE','EY'], ETH:['Ethiopian Airlines','ET','ET'], EVA:['EVA Air','TW','BR'],
  EZY:['easyJet','GB','U2'], EJU:['easyJet Europe','AT','U2'], EWG:['Eurowings','DE','EW'], EXS:['Jet2','GB','LS'],
  FDX:['FedEx Express','US','FX'], FIN:['Finnair','FI','AY'], FFT:['Frontier Airlines','US','F9'], FJI:['Fiji Airways','FJ','FJ'],
  GFA:['Gulf Air','BH','GF'], GIA:['Garuda Indonesia','ID','GA'], GLO:['Gol','BR','G3'], HAL:['Hawaiian Airlines','US','HA'],
  HVN:['Vietnam Airlines','VN','VN'], IBE:['Iberia','ES','IB'], IBS:['Iberia Express','ES','I2'], ICE:['Icelandair','IS','FI'],
  IGO:['IndiGo','IN','6E'], JAL:['Japan Airlines','JP','JL'], JBU:['JetBlue Airways','US','B6'], JST:['Jetstar','AU','JQ'],
  KAL:['Korean Air','KR','KE'], KLM:['KLM','NL','KL'], KQA:['Kenya Airways','KE','KQ'], LAN:['LATAM Airlines','CL','LA'],
  LOT:['LOT Polish Airlines','PL','LO'], LTU:['LTU','DE'], MAS:['Malaysia Airlines','MY','MH'], MAU:['Air Mauritius','MU','MK'],
  MEA:['Middle East Airlines','LB','ME'], MSR:['EgyptAir','EG','MS'], NAX:['Norwegian','NO','DY'], NOZ:['Norwegian Air','NO'],
  NKS:['Spirit Airlines','US','NK'], OAL:['Olympic Air','GR','OA'], PAL:['Philippine Airlines','PH','PR'],
  PGT:['Pegasus Airlines','TR','PC'], QFA:['Qantas','AU','QF'], QTR:['Qatar Airways','QA','QR'], RAM:['Royal Air Maroc','MA','AT'],
  RJA:['Royal Jordanian','JO','RJ'], ROT:['TAROM','RO','RO'], RYR:['Ryanair','IE','FR'], RUK:['Ryanair UK','GB','RK'],
  SAS:['SAS Scandinavian','SE','SK'], SIA:['Singapore Airlines','SG','SQ'], SVA:['Saudia','SA','SV'], SWA:['Southwest Airlines','US','WN'],
  SWR:['SWISS','CH','LX'], TAM:['LATAM Brasil','BR','JJ'], TAP:['TAP Air Portugal','PT','TP'], THA:['Thai Airways','TH','TG'],
  THY:['Turkish Airlines','TR','TK'], TOM:['TUI Airways','GB','BY'], TRA:['Transavia','NL','HV'], TVF:['Transavia France','FR','TO'],
  UAE:['Emirates','AE','EK'], UAL:['United Airlines','US','UA'], UPS:['UPS Airlines','US','5X'], VIR:['Virgin Atlantic','GB','VS'],
  VLG:['Vueling','ES','VY'], VOI:['Volaris','MX','Y4'], WJA:['WestJet','CA','WS'], WZZ:['Wizz Air','HU','W6'],
  WUK:['Wizz Air UK','GB','W9'], SKW:['SkyWest','US','OO'], ENY:['Envoy Air','US','MQ'], RPA:['Republic Airways','US','YX'],
  ASH:['Mesa Airlines','US','YV'], JIA:['PSA Airlines','US','OH'], EDV:['Endeavor Air','US','9E'], GJS:['GoJet','US','G7'],
  QXE:['Horizon Air','US','QX'], AJT:['Amerijet','US','M6'], ABX:['ABX Air','US','GB'], GTI:['Atlas Air','US','5Y'],
  CKS:['Kalitta Air','US','K4'], NCA:['Nippon Cargo','JP','KZ'], CLX:['Cargolux','LU','CV'], MPH:['Martinair','NL','MP'],
  BCS:['DHL Air','GB','QY'], DHK:['DHL Air UK','GB'], QAC:['DHL Aviation','BH'], SQC:['Singapore Cargo','SG'],
  UPS2:['UPS','US'], TSC:['Air Transat','CA','TS'], POE:['Porter Airlines','CA','PD'], FLE:['Flair Airlines','CA','F8'],
  SCX:['Sun Country','US','SY'], AAY:['Allegiant Air','US','G4'], VJT:['VistaJet','MT'], NJE:['NetJets Europe','PT'],
  EJA:['NetJets','US','1I'], LXJ:['Flexjet','US'], DCM:['Titan Airways','GB','ZT'], BGA:['Airbus Transport','FR'],
  AIB:['Airbus Industrie','FR'], BOE:['Boeing','US'], RCH:['US Air Mobility Command','US'],
  RRR:['Royal Air Force','GB'], CFC:['Canadian Forces','CA'], GAF:['German Air Force','DE'],
  IAM:['Italian Air Force','IT'], NATO:['NATO','—'], AME:['US Air Force','US'], HKY:['US Air Force','US'],
  SVR:['Ural Airlines','RU','U6'], SBI:['S7 Airlines','RU','S7'], AFG:['Ariana Afghan','AF','FG'], UZB:['Uzbekistan Airways','UZ','HY'],
  KZR:['Air Astana','KZ','KC'], AZG:['Silk Way West','AZ'], AHY:['Azerbaijan Airlines','AZ','J2'],
  ABY:['Air Arabia','AE','G9'], FDB:['flydubai','AE','FZ'], OMA:['Oman Air','OM','WY'], KAC:['Kuwait Airways','KW','KU'],
  JZR:['Jazeera Airways','KW','J9'], XY:['flynas','SA'], NAS:['flynas','SA','XY'], SEY:['Air Seychelles','SC','HM'],
  SAA:['South African Airways','ZA','SA'], MNO:['Aerolineas Argentinas','AR'], ARG:['Aerolineas Argentinas','AR','AR'],
  AVA:['Avianca','CO','AV'], CMP:['Copa Airlines','PA','CM'], AMX:['Aeromexico','MX','AM'], AZU:['Azul','BR','AD'],
  ONE:['Oneworld','—'], SKY:['Skymark','JP','BC'], APJ:['Peach Aviation','JP','MM'], JJP:['Jetstar Japan','JP','GK'],
  CEB:['Cebu Pacific','PH','5J'], LNI:['Lion Air','ID','JT'], BTK:['Batik Air','ID','ID'], TGW:['Scoot','SG','TR'],
  MXD:['Malindo Air','MY','OD'], THD:['Thai Smile','TH'], VTA:['Air Tahiti Nui','PF'], HDA:['Hong Kong Express','HK','UO'],
  CRK:['Hong Kong Airlines','HK','HX'], MAC:['Air Arabia Maroc','MA'], TUI:['TUI fly','BE'],
  SDR:['City Airlines','DE'], CFE:['BA CityFlyer','GB','CJ'], LOG:['Loganair','GB','LM'], EFW:['Contour','US'],
  BLA:['Blue Air','RO'], VOE:['Volotea','ES','V7'], WMT:['Wizz Air Malta','MT'], NOS:['Neos','IT','NO'],
  ISS:['Air Italy','IT'], AEA:['Air Europa','ES','UX'], EVE:['Air Evelop','ES'], PLM:['Plus Ultra','ES','PU'],
  SXS:['SunExpress','TR','XQ'], KKK:['AtlasGlobal','TR'], AJA:['Anadolujet','TR'], FHY:['Freebird','TR'],
  UKL:['Ukraine Air Alliance','UA'], AUI:['Ukraine International','UA','PS'], BLX:['TUI fly Nordic','SE'],
  NSZ:['Norse Atlantic','NO'], DTR:['TUI fly Deutschland','DE'], HLX:['Hapag-Lloyd Express','DE'],
  LGL:['Luxair','LU','LG'], SWU:['Sundair','DE'], EWE:['Eurowings Europe','MT'], AEU:['Astra Airlines','GR'],
  MSJ:['Air Serbia','RS','JU'], JAT:['Air Serbia','RS'], BUC:['Bulgarian Air Charter','BG'], LZB:['Bulgaria Air','BG','FB'],
};

// ICAO type designator -> readable model name
const AIRCRAFT_TYPES = {
  A19N:'Airbus A319neo', A20N:'Airbus A320neo', A21N:'Airbus A321neo', A318:'Airbus A318',
  A319:'Airbus A319', A320:'Airbus A320', A321:'Airbus A321', A332:'Airbus A330-200',
  A333:'Airbus A330-300', A337:'Airbus A330-700 Beluga XL', A338:'Airbus A330-800neo',
  A339:'Airbus A330-900neo', A342:'Airbus A340-200', A343:'Airbus A340-300', A345:'Airbus A340-500',
  A346:'Airbus A340-600', A359:'Airbus A350-900', A35K:'Airbus A350-1000', A388:'Airbus A380-800',
  A3ST:'Airbus A300-600ST Beluga', A306:'Airbus A300-600', A310:'Airbus A310', A30B:'Airbus A300B',
  B712:'Boeing 717-200', B732:'Boeing 737-200', B733:'Boeing 737-300', B734:'Boeing 737-400',
  B735:'Boeing 737-500', B736:'Boeing 737-600', B737:'Boeing 737-700', B738:'Boeing 737-800',
  B739:'Boeing 737-900', B37M:'Boeing 737 MAX 7', B38M:'Boeing 737 MAX 8', B39M:'Boeing 737 MAX 9',
  B3XM:'Boeing 737 MAX 10', B741:'Boeing 747-100', B742:'Boeing 747-200', B743:'Boeing 747-300',
  B744:'Boeing 747-400', B748:'Boeing 747-8', B74F:'Boeing 747 Freighter', B74S:'Boeing 747SP',
  B752:'Boeing 757-200', B753:'Boeing 757-300', B762:'Boeing 767-200', B763:'Boeing 767-300',
  B764:'Boeing 767-400', B772:'Boeing 777-200', B773:'Boeing 777-300', B77L:'Boeing 777-200LR',
  B77W:'Boeing 777-300ER', B778:'Boeing 777-8', B779:'Boeing 777-9', B77F:'Boeing 777F',
  B788:'Boeing 787-8', B789:'Boeing 787-9', B78X:'Boeing 787-10', BLCF:'Boeing 747 Dreamlifter',
  E135:'Embraer ERJ-135', E145:'Embraer ERJ-145', E170:'Embraer 170', E75L:'Embraer 175',
  E75S:'Embraer 175', E190:'Embraer 190', E195:'Embraer 195', E290:'Embraer E190-E2',
  E295:'Embraer E195-E2', E50P:'Embraer Phenom 100', E55P:'Embraer Phenom 300',
  E545:'Embraer Legacy 450', E550:'Embraer Legacy 500', E35L:'Embraer Legacy 600',
  CRJ2:'Bombardier CRJ-200', CRJ7:'Bombardier CRJ-700', CRJ9:'Bombardier CRJ-900',
  CRJX:'Bombardier CRJ-1000', BCS1:'Airbus A220-100', BCS3:'Airbus A220-300',
  DH8A:'De Havilland Dash 8-100', DH8B:'De Havilland Dash 8-200', DH8C:'De Havilland Dash 8-300',
  DH8D:'De Havilland Dash 8-400', AT43:'ATR 42-300', AT45:'ATR 42-500', AT46:'ATR 42-600',
  AT72:'ATR 72', AT75:'ATR 72-500', AT76:'ATR 72-600', SF34:'Saab 340', SB20:'Saab 2000',
  MD11:'McDonnell Douglas MD-11', MD82:'McDonnell Douglas MD-82', MD83:'McDonnell Douglas MD-83',
  MD88:'McDonnell Douglas MD-88', MD90:'McDonnell Douglas MD-90', DC10:'McDonnell Douglas DC-10',
  DC93:'Douglas DC-9-30', DC3:'Douglas DC-3', B461:'BAe 146-100', B462:'BAe 146-200',
  B463:'BAe 146-300', RJ85:'Avro RJ85', RJ1H:'Avro RJ100', F70:'Fokker 70', F100:'Fokker 100',
  SU95:'Sukhoi Superjet 100', A148:'Antonov An-148', AN12:'Antonov An-12', AN24:'Antonov An-24',
  AN26:'Antonov An-26', AN72:'Antonov An-72', AN124:'Antonov An-124', A124:'Antonov An-124 Ruslan',
  A225:'Antonov An-225 Mriya', IL76:'Ilyushin Il-76', IL96:'Ilyushin Il-96', T204:'Tupolev Tu-204',
  T154:'Tupolev Tu-154', C25A:'Cessna Citation CJ2', C25B:'Cessna Citation CJ3',
  C25C:'Cessna Citation CJ4', C56X:'Cessna Citation Excel', C68A:'Cessna Citation Latitude',
  C700:'Cessna Citation Longitude', C750:'Cessna Citation X', C172:'Cessna 172 Skyhawk',
  C182:'Cessna 182 Skylane', C208:'Cessna 208 Caravan', C210:'Cessna 210 Centurion',
  C441:'Cessna 441 Conquest', PC12:'Pilatus PC-12', PC24:'Pilatus PC-24', TBM7:'Daher TBM 700',
  TBM9:'Daher TBM 900', SR20:'Cirrus SR20', SR22:'Cirrus SR22', SF50:'Cirrus Vision Jet',
  DA40:'Diamond DA40', DA42:'Diamond DA42', DA62:'Diamond DA62', P28A:'Piper PA-28 Cherokee',
  PA31:'Piper Navajo', PA34:'Piper Seneca', PA46:'Piper Malibu', BE20:'Beechcraft King Air 200',
  BE36:'Beechcraft Bonanza', BE58:'Beechcraft Baron', B350:'Beechcraft King Air 350',
  GLF4:'Gulfstream IV', GLF5:'Gulfstream V', GLF6:'Gulfstream G650', G280:'Gulfstream G280',
  GL5T:'Bombardier Global 5000', GL7T:'Bombardier Global 7500', GLEX:'Bombardier Global Express',
  CL30:'Bombardier Challenger 300', CL35:'Bombardier Challenger 350', CL60:'Bombardier Challenger 600',
  LJ35:'Learjet 35', LJ45:'Learjet 45', LJ60:'Learjet 60', F2TH:'Dassault Falcon 2000',
  F900:'Dassault Falcon 900', FA7X:'Dassault Falcon 7X', FA8X:'Dassault Falcon 8X',
  H25B:'Hawker 800', HDJT:'Honda HA-420 HondaJet', E120:'Embraer EMB-120 Brasilia',
  C130:'Lockheed C-130 Hercules', C30J:'Lockheed C-130J Super Hercules', C17:'Boeing C-17 Globemaster III',
  C5M:'Lockheed C-5M Super Galaxy', K35R:'Boeing KC-135 Stratotanker', KC46:'Boeing KC-46 Pegasus',
  A400:'Airbus A400M Atlas', A330MRTT:'Airbus A330 MRTT', E3TF:'Boeing E-3 Sentry',
  P8:'Boeing P-8 Poseidon', RC135:'Boeing RC-135', E6:'Boeing E-6 Mercury', F16:'Lockheed F-16',
  F15:'Boeing F-15 Eagle', F18:'Boeing F/A-18 Hornet', F22:'Lockheed F-22 Raptor',
  F35:'Lockheed F-35 Lightning II', EUFI:'Eurofighter Typhoon', RFAL:'Dassault Rafale',
  TOR:'Panavia Tornado', A10:'Fairchild A-10 Thunderbolt II', H60:'Sikorsky UH-60 Black Hawk',
  EC35:'Airbus H135', EC45:'Airbus H145', EC30:'Airbus H130', AS50:'Airbus AS350 Ecureuil',
  A139:'Leonardo AW139', A169:'Leonardo AW169', A189:'Leonardo AW189', B06:'Bell 206 JetRanger',
  B407:'Bell 407', B412:'Bell 412', B429:'Bell 429', R44:'Robinson R44', R66:'Robinson R66',
  S76:'Sikorsky S-76', S92:'Sikorsky S-92', GLID:'Glider', BALL:'Balloon', ULAC:'Ultralight',
  SHIP:'Airship', DRON:'Drone / UAS', GRND:'Ground vehicle',
};

// ADS-B emitter categories
const CATEGORIES = {
  A0:'No information', A1:'Light (< 15 500 lb)', A2:'Small (15 500 - 75 000 lb)',
  A3:'Large (75 000 - 300 000 lb)', A4:'High-vortex large (B757)', A5:'Heavy (> 300 000 lb)',
  A6:'High performance', A7:'Rotorcraft', B0:'No information', B1:'Glider / sailplane',
  B2:'Lighter-than-air', B3:'Parachutist / skydiver', B4:'Ultralight / paraglider',
  B6:'UAV / drone', B7:'Space vehicle', C0:'No information', C1:'Emergency vehicle',
  C2:'Service vehicle', C3:'Fixed obstruction',
};

// Special squawk codes worth calling out
const SQUAWKS = {
  '7500':'Unlawful interference (hijack)', '7600':'Radio failure', '7700':'General emergency',
  '7777':'Military interception', '1200':'VFR (US)', '7000':'VFR (Europe)', '2000':'IFR, no code assigned',
  '7501':'Hijack (extended)', '0000':'Transponder fault / SSR',
};

// ICAO 24-bit address blocks -> country of registration.
// Sorted ranges, resolved with a binary-ish scan in lookupCountry().
const HEX_RANGES = [
  [0x004000,0x0043ff,'Zimbabwe','ZW'], [0x006000,0x006fff,'Mozambique','MZ'],
  [0x008000,0x00ffff,'South Africa','ZA'], [0x010000,0x017fff,'Egypt','EG'],
  [0x018000,0x01ffff,'Libya','LY'], [0x020000,0x027fff,'Morocco','MA'],
  [0x028000,0x02ffff,'Tunisia','TN'], [0x030000,0x0303ff,'Botswana','BW'],
  [0x032000,0x032fff,'Burundi','BI'], [0x034000,0x034fff,'Cameroon','CM'],
  [0x035000,0x0353ff,'Comoros','KM'], [0x036000,0x036fff,'Congo','CG'],
  [0x038000,0x038fff,'Côte d’Ivoire','CI'], [0x03e000,0x03efff,'Gabon','GA'],
  [0x040000,0x040fff,'Ethiopia','ET'], [0x042000,0x042fff,'Equatorial Guinea','GQ'],
  [0x044000,0x044fff,'Ghana','GH'], [0x046000,0x046fff,'Guinea','GN'],
  [0x048000,0x0483ff,'Guinea-Bissau','GW'], [0x04a000,0x04a3ff,'Lesotho','LS'],
  [0x04c000,0x04cfff,'Kenya','KE'], [0x050000,0x050fff,'Liberia','LR'],
  [0x054000,0x054fff,'Madagascar','MG'], [0x058000,0x058fff,'Malawi','MW'],
  [0x05a000,0x05a3ff,'Maldives','MV'], [0x05c000,0x05cfff,'Mali','ML'],
  [0x05e000,0x05e3ff,'Mauritania','MR'], [0x060000,0x0603ff,'Mauritius','MU'],
  [0x062000,0x062fff,'Niger','NE'], [0x064000,0x064fff,'Nigeria','NG'],
  [0x068000,0x068fff,'Uganda','UG'], [0x06a000,0x06a3ff,'Qatar','QA'],
  [0x06c000,0x06cfff,'Central African Rep.','CF'], [0x06e000,0x06efff,'Rwanda','RW'],
  [0x070000,0x070fff,'Senegal','SN'], [0x074000,0x0743ff,'Seychelles','SC'],
  [0x076000,0x0763ff,'Sierra Leone','SL'], [0x078000,0x078fff,'Somalia','SO'],
  [0x07a000,0x07a3ff,'Eswatini','SZ'], [0x07c000,0x07cfff,'Sudan','SD'],
  [0x080000,0x080fff,'Tanzania','TZ'], [0x084000,0x084fff,'Chad','TD'],
  [0x088000,0x088fff,'Togo','TG'], [0x08a000,0x08afff,'Zambia','ZM'],
  [0x08c000,0x08cfff,'DR Congo','CD'], [0x090000,0x090fff,'Angola','AO'],
  [0x094000,0x0943ff,'Burkina Faso','BF'], [0x096000,0x0963ff,'Malawi','MW'],
  [0x09a000,0x09afff,'Benin','BJ'], [0x09e000,0x09e3ff,'Cabo Verde','CV'],
  [0x0a0000,0x0a7fff,'Algeria','DZ'], [0x0a8000,0x0a83ff,'Gambia','GM'],
  [0x0aa000,0x0aa3ff,'Namibia','NA'], [0x0ac000,0x0ac3ff,'São Tomé','ST'],
  [0x0b0000,0x0b0fff,'Eritrea','ER'], [0x100000,0x1fffff,'Russia','RU'],
  [0x201000,0x2013ff,'Namibia','NA'], [0x202000,0x2023ff,'Eritrea','ER'],
  [0x300000,0x33ffff,'Italy','IT'], [0x340000,0x37ffff,'Spain','ES'],
  [0x380000,0x3bffff,'France','FR'], [0x3c0000,0x3fffff,'Germany','DE'],
  [0x400000,0x43ffff,'United Kingdom','GB'], [0x440000,0x447fff,'Austria','AT'],
  [0x448000,0x44ffff,'Belgium','BE'], [0x450000,0x457fff,'Denmark','DK'],
  [0x458000,0x45ffff,'Finland','FI'], [0x460000,0x467fff,'Greece','GR'],
  [0x468000,0x46ffff,'Hungary','HU'], [0x470000,0x4703ff,'Norway','NO'],
  [0x478000,0x47ffff,'Norway','NO'], [0x480000,0x487fff,'Netherlands','NL'],
  [0x488000,0x48ffff,'Poland','PL'], [0x490000,0x497fff,'Portugal','PT'],
  [0x498000,0x49ffff,'Czechia','CZ'], [0x4a0000,0x4a7fff,'Romania','RO'],
  [0x4a8000,0x4affff,'Sweden','SE'], [0x4b0000,0x4b7fff,'Switzerland','CH'],
  [0x4b8000,0x4bffff,'Türkiye','TR'], [0x4c0000,0x4c7fff,'Serbia','RS'],
  [0x4c8000,0x4c83ff,'Cyprus','CY'], [0x4ca000,0x4cafff,'Ireland','IE'],
  [0x4cc000,0x4ccfff,'Iceland','IS'], [0x4d0000,0x4d03ff,'Luxembourg','LU'],
  [0x4d2000,0x4d23ff,'Malta','MT'], [0x4d4000,0x4d43ff,'Monaco','MC'],
  [0x500000,0x5003ff,'San Marino','SM'], [0x501000,0x5013ff,'Albania','AL'],
  [0x501c00,0x501fff,'Croatia','HR'], [0x502c00,0x502fff,'Latvia','LV'],
  [0x503c00,0x503fff,'Lithuania','LT'], [0x504c00,0x504fff,'Moldova','MD'],
  [0x505c00,0x505fff,'Slovakia','SK'], [0x506c00,0x506fff,'Slovenia','SI'],
  [0x507c00,0x507fff,'Uzbekistan','UZ'], [0x508000,0x50ffff,'Ukraine','UA'],
  [0x510000,0x5103ff,'Belarus','BY'], [0x511000,0x5113ff,'Estonia','EE'],
  [0x512000,0x5123ff,'North Macedonia','MK'], [0x513000,0x5133ff,'Bosnia','BA'],
  [0x514000,0x5143ff,'Georgia','GE'], [0x515000,0x5153ff,'Tajikistan','TJ'],
  [0x516000,0x5163ff,'Montenegro','ME'], [0x600000,0x6003ff,'Armenia','AM'],
  [0x600800,0x600bff,'Azerbaijan','AZ'], [0x601000,0x6013ff,'Kyrgyzstan','KG'],
  [0x601800,0x601bff,'Turkmenistan','TM'], [0x680000,0x6803ff,'Bhutan','BT'],
  [0x681000,0x6813ff,'Micronesia','FM'], [0x682000,0x6823ff,'Mongolia','MN'],
  [0x683000,0x6833ff,'Kazakhstan','KZ'], [0x684000,0x6843ff,'Palau','PW'],
  [0x700000,0x700fff,'Afghanistan','AF'], [0x702000,0x702fff,'Bangladesh','BD'],
  [0x704000,0x704fff,'Myanmar','MM'], [0x706000,0x706fff,'Kuwait','KW'],
  [0x708000,0x708fff,'Laos','LA'], [0x70a000,0x70afff,'Nepal','NP'],
  [0x70c000,0x70c3ff,'Oman','OM'], [0x70e000,0x70efff,'Cambodia','KH'],
  [0x710000,0x717fff,'Saudi Arabia','SA'], [0x718000,0x71ffff,'South Korea','KR'],
  [0x720000,0x727fff,'North Korea','KP'], [0x728000,0x72ffff,'Iraq','IQ'],
  [0x730000,0x737fff,'Iran','IR'], [0x738000,0x73ffff,'Israel','IL'],
  [0x740000,0x747fff,'Jordan','JO'], [0x748000,0x74ffff,'Lebanon','LB'],
  [0x750000,0x757fff,'Malaysia','MY'], [0x758000,0x75ffff,'Philippines','PH'],
  [0x760000,0x767fff,'Pakistan','PK'], [0x768000,0x76ffff,'Singapore','SG'],
  [0x770000,0x777fff,'Sri Lanka','LK'], [0x778000,0x77ffff,'Syria','SY'],
  [0x780000,0x7bffff,'China','CN'], [0x7c0000,0x7fffff,'Australia','AU'],
  [0x800000,0x83ffff,'India','IN'], [0x840000,0x87ffff,'Japan','JP'],
  [0x880000,0x887fff,'Thailand','TH'], [0x888000,0x88ffff,'Viet Nam','VN'],
  [0x890000,0x890fff,'Yemen','YE'], [0x894000,0x894fff,'Bahrain','BH'],
  [0x895000,0x8953ff,'Brunei','BN'], [0x896000,0x896fff,'UAE','AE'],
  [0x897000,0x8973ff,'Solomon Islands','SB'], [0x898000,0x898fff,'Papua New Guinea','PG'],
  [0x899000,0x8993ff,'Taiwan','TW'], [0x89a000,0x89a3ff,'Hong Kong','HK'],
  [0x8a0000,0x8a7fff,'Indonesia','ID'], [0x900000,0x9003ff,'Marshall Islands','MH'],
  [0x901000,0x9013ff,'Cook Islands','CK'], [0x902000,0x9023ff,'Samoa','WS'],
  [0xa00000,0xafffff,'United States','US'], [0xc00000,0xc3ffff,'Canada','CA'],
  [0xc80000,0xc87fff,'New Zealand','NZ'], [0xc88000,0xc88fff,'Fiji','FJ'],
  [0xc8a000,0xc8a3ff,'Nauru','NR'], [0xc8c000,0xc8c3ff,'Vanuatu','VU'],
  [0xc8e000,0xc8e3ff,'Tonga','TO'], [0xc90000,0xc903ff,'Kiribati','KI'],
  [0xc91000,0xc913ff,'Tuvalu','TV'], [0xe00000,0xe3ffff,'Argentina','AR'],
  [0xe40000,0xe7ffff,'Brazil','BR'], [0xe80000,0xe80fff,'Chile','CL'],
  [0xe84000,0xe84fff,'Ecuador','EC'], [0xe88000,0xe88fff,'Paraguay','PY'],
  [0xe8c000,0xe8cfff,'Peru','PE'], [0xe90000,0xe90fff,'Uruguay','UY'],
  [0xe94000,0xe94fff,'Bolivia','BO'], [0x0d0000,0x0d7fff,'Mexico','MX'],
  [0x0a4000,0x0a4fff,'Colombia','CO'], [0x0ac800,0x0acbff,'Venezuela','VE'],
  [0x0b1000,0x0b13ff,'Cuba','CU'], [0x0b2000,0x0b23ff,'Dominican Rep.','DO'],
  [0x0b3000,0x0b33ff,'Costa Rica','CR'], [0x0b4000,0x0b43ff,'Panama','PA'],
  [0x0b5000,0x0b53ff,'Jamaica','JM'], [0x0b6000,0x0b63ff,'Guatemala','GT'],
  [0x0b7000,0x0b73ff,'Honduras','HN'], [0x0b8000,0x0b83ff,'El Salvador','SV'],
  [0x0b9000,0x0b93ff,'Nicaragua','NI'], [0x0ba000,0x0ba3ff,'Bahamas','BS'],
  [0x0bb000,0x0bb3ff,'Barbados','BB'], [0x0bc000,0x0bc3ff,'Belize','BZ'],
  [0x0bd000,0x0bd3ff,'Trinidad & Tobago','TT'], [0x0be000,0x0be3ff,'Guyana','GY'],
  [0x0bf000,0x0bf3ff,'Suriname','SR'], [0x0c0000,0x0c03ff,'Haiti','HT'],
  [0x0c2000,0x0c23ff,'Grenada','GD'], [0xf00000,0xf07fff,'ICAO temporary','ZZ'],
].filter(Boolean);

function lookupCountry(hex) {
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return null;
  for (let i = 0; i < HEX_RANGES.length; i++) {
    const r = HEX_RANGES[i];
    if (n >= r[0] && n <= r[1]) return { name: r[2], iso: r[3] };
  }
  return null;
}

// ISO 3166-1 alpha-2 -> flag emoji (regional indicator pair)
function flagOf(iso) {
  if (!iso || iso.length !== 2 || !/^[A-Za-z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(
    ...iso.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

// "BAW117" -> { code:'BAW', name:'British Airways', flight:'BA117' }
function decodeCallsign(cs) {
  if (!cs) return null;
  const m = /^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$/.exec(cs.trim().toUpperCase());
  if (!m) return null;
  const info = AIRLINES[m[1]];
  if (!info) return { code: m[1], name: null, number: m[2] };
  return { code: m[1], name: info[0], iso: info[1], iata: info[2] || null, number: m[2] };
}

function typeName(t) {
  if (!t) return null;
  return AIRCRAFT_TYPES[t.toUpperCase()] || null;
}

window.REF = { AIRLINES, AIRCRAFT_TYPES, CATEGORIES, SQUAWKS, lookupCountry, flagOf, decodeCallsign, typeName };
