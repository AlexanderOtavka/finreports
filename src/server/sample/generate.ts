/**
 * A deterministic, made-up year of transactions for a car-free household of two adults in
 * New York City (Brooklyn): rent, paychecks, transit, bike share, the occasional rideshare,
 * groceries and delivery, restaurants and coffee, utilities, phone and internet, streaming,
 * gyms, a cat, travel, healthcare, credit card payments as transfers, refunds, pending
 * charges, and the messy raw descriptions banks really send. No car: no gas, parking, tolls,
 * auto insurance, or car payments.
 *
 * Each day is generated from its own PRNG seeded by (seed, date), so a day always comes out
 * the same however the window moves: moving the end date only adds or drops whole days, and
 * external ids stay stable.
 *
 * Plaid's categories are attached as Plaid would: mostly right, and consistently wrong for
 * some merchants (Uber Eats as rideshare, Citi Bike as rideshare, a cat clinic as a doctor,
 * a laundromat as "other shopping"), which is what makes recategorizing worth doing.
 */

export interface SampleAccount {
  id: string;
  name: string;
  type: "checking" | "savings" | "credit";
}

export const SAMPLE_ACCOUNTS: SampleAccount[] = [
  { id: "chk", name: "Joint Checking ••4417", type: "checking" },
  { id: "sav", name: "High-Yield Savings ••9021", type: "savings" },
  { id: "jordan", name: "Jordan Rewards Visa ••3308", type: "credit" },
  { id: "sam", name: "Sam Cash Back Mastercard ••7725", type: "credit" },
];

const accountName = (id: string): string => SAMPLE_ACCOUNTS.find((a) => a.id === id)!.name;

export interface SampleTxn {
  externalId: string;
  date: string;
  amount: number;
  type: "withdrawal" | "deposit" | "transfer";
  pending: boolean;
  merchant: string | null;
  description: string;
  accountId: string;
  accountName: string;
  counterparty: string | null;
  plaid: { primary: string; detailed: string };
  /** What a careful person would call it; differs from `plaid` for mis-categorizations. */
  truth: { primary: string; detailed: string };
  replacesExternalId: string | null;
  /** What Plaid knows about the merchant, as the connector writes it into the ledger. */
  website: string | null;
  location: { lat: number; lon: number } | null;
  /** Notes and tags someone added in the ledger. */
  notes: string | null;
  tags: string[];
}

// ---------------------------------------------------------------------------------------
// Randomness

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32 */
export function prng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);
const cents = (value: number): number => Math.round(value * 100) / 100;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const digits = (rng: Rng, n: number): string =>
  Array.from({ length: n }, () => Math.floor(rng() * 10)).join("");
const ref = (rng: Rng, n: number): string =>
  Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(rng() * 34)]).join("");

// ---------------------------------------------------------------------------------------
// Calendar

export interface Day {
  date: string;
  /** 0 = Sunday */
  dow: number;
  dom: number;
  month: number; // 1-12
  year: number;
  daysInMonth: number;
  weekend: boolean;
  /** Days since 1970-01-01. */
  epochDay: number;
}

export function toDay(iso: string): Day {
  const d = new Date(`${iso}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const dow = d.getUTCDay();
  return {
    date: iso,
    dow,
    dom: d.getUTCDate(),
    month,
    year,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    weekend: dow === 0 || dow === 6,
    epochDay: Math.floor(d.getTime() / 86_400_000),
  };
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The last weekday of the month, the day payroll lands. */
function isLastBusinessDay(day: Day): boolean {
  if (day.weekend) return false;
  for (let dom = day.dom + 1; dom <= day.daysInMonth; dom += 1) {
    const dow = (day.dow + (dom - day.dom)) % 7;
    if (dow !== 0 && dow !== 6) return false;
  }
  return true;
}

/** A business day on or after `dom` (the first one), for bills that skip weekends. */
function isFirstBusinessDayFrom(day: Day, dom: number): boolean {
  if (day.weekend || day.dom < dom) return false;
  for (let d = dom; d < day.dom; d += 1) {
    const dow = (day.dow - (day.dom - d) + 7 * 5) % 7;
    if (dow !== 0 && dow !== 6) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// The household's merchants

type Cat = readonly [primary: string, detailed: string];

interface Emit {
  merchant: string | null;
  description: string;
  amount: number; // positive = money out (a charge), negative = money in
  account: string;
  plaid: Cat;
  truth?: Cat;
  type?: "withdrawal" | "deposit" | "transfer";
  counterparty?: string;
  /** Restaurants: authorized before the tip, so they post a few days later. */
  tipped?: boolean;
}

type Generator = (day: Day, rng: Rng) => Emit[];

const C = {
  salary: ["INCOME", "SALARY"],
  interest: ["INCOME", "INTEREST_EARNED"],
  taxRefund: ["INCOME", "TAX_REFUND"],
  rent: ["RENT_AND_UTILITIES", "RENT"],
  power: ["RENT_AND_UTILITIES", "GAS_AND_ELECTRICITY"],
  internet: ["RENT_AND_UTILITIES", "INTERNET_AND_CABLE"],
  phone: ["RENT_AND_UTILITIES", "TELEPHONE"],
  groceries: ["FOOD_AND_DRINK", "GROCERIES"],
  restaurant: ["FOOD_AND_DRINK", "RESTAURANT"],
  fastFood: ["FOOD_AND_DRINK", "FAST_FOOD"],
  coffee: ["FOOD_AND_DRINK", "COFFEE"],
  booze: ["FOOD_AND_DRINK", "BEER_WINE_AND_LIQUOR"],
  transit: ["TRANSPORTATION", "PUBLIC_TRANSIT"],
  rideshare: ["TRANSPORTATION", "TAXIS_AND_RIDE_SHARES"],
  bikes: ["TRANSPORTATION", "BIKES_AND_SCOOTERS"],
  tv: ["ENTERTAINMENT", "TV_AND_MOVIES"],
  music: ["ENTERTAINMENT", "MUSIC_AND_AUDIO"],
  events: ["ENTERTAINMENT", "SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS"],
  news: ["GENERAL_MERCHANDISE", "BOOKSTORES_AND_NEWSSTANDS"],
  marketplace: ["GENERAL_MERCHANDISE", "ONLINE_MARKETPLACES"],
  superstore: ["GENERAL_MERCHANDISE", "SUPERSTORES"],
  clothing: ["GENERAL_MERCHANDISE", "CLOTHING_AND_ACCESSORIES"],
  convenience: ["GENERAL_MERCHANDISE", "CONVENIENCE_STORES"],
  petSupplies: ["GENERAL_MERCHANDISE", "PET_SUPPLIES"],
  otherShopping: ["GENERAL_MERCHANDISE", "OTHER_GENERAL_MERCHANDISE"],
  hardware: ["HOME_IMPROVEMENT", "HARDWARE"],
  pharmacy: ["MEDICAL", "PHARMACIES_AND_SUPPLEMENTS"],
  doctor: ["MEDICAL", "PRIMARY_CARE"],
  dentist: ["MEDICAL", "DENTAL_CARE"],
  vet: ["MEDICAL", "VETERINARY_SERVICES"],
  gym: ["PERSONAL_CARE", "GYMS_AND_FITNESS_CENTERS"],
  hair: ["PERSONAL_CARE", "HAIR_AND_BEAUTY"],
  laundry: ["PERSONAL_CARE", "LAUNDRY_AND_DRY_CLEANING"],
  insurance: ["GENERAL_SERVICES", "INSURANCE"],
  otherServices: ["GENERAL_SERVICES", "OTHER_GENERAL_SERVICES"],
  shipping: ["GENERAL_SERVICES", "POSTAGE_AND_SHIPPING"],
  donations: ["GOVERNMENT_AND_NON_PROFIT", "DONATIONS"],
  flights: ["TRAVEL", "FLIGHTS"],
  lodging: ["TRAVEL", "LODGING"],
  otherTravel: ["TRAVEL", "OTHER_TRAVEL"],
  fxFee: ["BANK_FEES", "FOREIGN_TRANSACTION_FEES"],
  atmFee: ["BANK_FEES", "ATM_FEES"],
  ccPayment: ["LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT"],
  toSavings: ["TRANSFER_OUT", "SAVINGS"],
  toApps: ["TRANSFER_OUT", "TRANSFER_OUT_FROM_APPS"],
  fromApps: ["TRANSFER_IN", "TRANSFER_IN_FROM_APPS"],
  cash: ["TRANSFER_OUT", "WITHDRAWAL"],
} as const satisfies Record<string, Cat>;

/** Trips away: [first day, last day] as month/day, and where. */
const TRIPS = [
  { from: [12, 21], to: [12, 28], place: "Chicago", fly: "UNITED", stay: "AIRBNB" },
  { from: [3, 13], to: [3, 16], place: "Boston", train: true, stay: "HOTEL" },
  { from: [6, 6], to: [6, 15], place: "Lisbon", fly: "TAP AIR PORTUGAL", stay: "AIRBNB", abroad: true },
  { from: [8, 22], to: [8, 25], place: "Montauk", train: true, stay: "HOTEL" },
] as const;

function tripOn(day: Day): (typeof TRIPS)[number] | undefined {
  const md = day.month * 100 + day.dom;
  return TRIPS.find((t) => md >= t.from[0] * 100 + t.from[1] && md <= t.to[0] * 100 + t.to[1]);
}

function tripBookedOn(day: Day): (typeof TRIPS)[number] | undefined {
  // Booked about six weeks ahead.
  const ahead = toDay(addDays(day.date, 42));
  return TRIPS.find((t) => t.from[0] === ahead.month && t.from[1] === ahead.dom);
}

/** Seasonal electricity: air conditioning in summer, a little more in winter. */
function conEdBill(day: Day, rng: Rng): number {
  const base = { 1: 118, 2: 110, 3: 92, 4: 78, 5: 84, 6: 128, 7: 164, 8: 171, 9: 122, 10: 82, 11: 88, 12: 112 }[
    day.month
  ]!;
  return cents(base + between(rng, -12, 12));
}

const RESTAURANTS: Array<{ merchant: string | null; desc: string; min: number; max: number }> = [
  { merchant: "Lucali", desc: "TST* LUCALI", min: 70, max: 120 },
  { merchant: "Roberta's", desc: "SQ *ROBERTAS PIZZA", min: 55, max: 110 },
  { merchant: "Olmsted", desc: "OLMSTED", min: 120, max: 210 },
  { merchant: null, desc: "TST* KING NOODLE - BROOKLYN", min: 38, max: 70 },
  { merchant: "Fonda", desc: "FONDA PARK SLOPE", min: 60, max: 115 },
  { merchant: null, desc: "SQ *TACOS EL BRAVO 0441 BROOKLYN NY", min: 18, max: 36 },
  { merchant: "Miriam", desc: "MIRIAM RESTAURANT", min: 45, max: 90 },
  { merchant: "Shake Shack", desc: "SHAKE SHACK #1066", min: 22, max: 41 },
  { merchant: "Sweetgreen", desc: "SWEETGREEN FLATIRON", min: 15, max: 32 },
];

const COFFEE: Array<{ merchant: string | null; desc: string; plaid?: Cat }> = [
  { merchant: "Blue Bottle Coffee", desc: "BLUE BOTTLE COFFEE BRKLYN" },
  { merchant: "Devoción", desc: "SQ *DEVOCION" },
  // Joe Coffee's card reader reports itself as its retail arm; Plaid files it as shopping.
  { merchant: null, desc: "JOE PRO SHOP 0118 NEW YORK NY", plaid: C.otherShopping },
  { merchant: "Gorilla Coffee", desc: "SQ *GORILLA COFFEE" },
];

/**
 * Plaid's website and location for a merchant, matched on its name or raw description: chains
 * and online shops have a website, the shops and restaurants down the street a location (as
 * Plaid has them: not for every merchant, and often not for the ones that most need it).
 */
const MERCHANT_DETAILS: Array<{ match: RegExp; website?: string; at?: readonly [lat: number, lon: number] }> = [
  { match: /^Lucali$/, website: "lucali.com", at: [40.6818, -73.9998] },
  { match: /^Roberta's$/, website: "robertaspizza.com", at: [40.7051, -73.9336] },
  { match: /^Olmsted$/, website: "olmstednyc.com", at: [40.6775, -73.9685] },
  { match: /KING NOODLE/, at: [40.7004, -73.9268] },
  { match: /^Fonda$/, website: "fondarestaurant.com", at: [40.6693, -73.9817] },
  { match: /TACOS EL BRAVO/, at: [40.6449, -74.0108] },
  { match: /^Miriam$/, website: "miriamrestaurant.com", at: [40.6761, -73.9806] },
  { match: /^Shake Shack$/, website: "shakeshack.com", at: [40.6911, -73.9868] },
  { match: /^Sweetgreen$/, website: "sweetgreen.com", at: [40.7392, -73.9897] },
  { match: /^Blue Bottle Coffee$/, website: "bluebottlecoffee.com", at: [40.7186, -73.9563] },
  { match: /^Devoción$/, website: "devocion.com", at: [40.7163, -73.9649] },
  // The card reader says "pro shop"; the location and website say coffee.
  { match: /JOE PRO SHOP/, website: "joecoffeecompany.com", at: [40.7335, -74.0027] },
  { match: /^Gorilla Coffee$/, website: "gorillacoffee.com", at: [40.6786, -73.9792] },
  { match: /^Trader Joe's$/, website: "traderjoes.com", at: [40.6886, -73.9922] },
  { match: /^Whole Foods Market$/, website: "wholefoodsmarket.com", at: [40.6747, -73.9895] },
  { match: /^FreshDirect$/, website: "freshdirect.com" },
  { match: /^Slope Cellars$/, at: [40.6719, -73.9772] },
  { match: /^The Gate$/, at: [40.6730, -73.9830] },
  { match: /^Target$/, website: "target.com", at: [40.6838, -73.9772] },
  { match: /^Uniqlo$/, website: "uniqlo.com", at: [40.7240, -73.9985] },
  { match: /BRKLYN HARDWARE/, at: [40.6774, -73.9805] },
  { match: /BROOKLYN CAT CLINIC/, at: [40.6702, -73.9858] },
  { match: /PARK SLOPE DENTAL/, at: [40.6741, -73.9786] },
  { match: /FRESH CUTS BARBERSHOP/, at: [40.6787, -73.9744] },
  { match: /BLINK FITNESS/, website: "blinkfitness.com", at: [40.6804, -73.9752] },
  { match: /^Equinox$/, website: "equinox.com", at: [40.6929, -73.9918] },
  { match: /^CVS$/, website: "cvs.com", at: [40.6765, -73.9799] },
  { match: /^Alamo Drafthouse$/, website: "drafthouse.com", at: [40.6911, -73.9837] },
  { match: /^Brooklyn Museum$/, website: "brooklynmuseum.org", at: [40.6712, -73.9636] },
  { match: /^Amazon$/, website: "amazon.com" },
  { match: /^Chewy$/, website: "chewy.com" },
  { match: /^DoorDash$/, website: "doordash.com" },
  { match: /^Uber Eats$/, website: "ubereats.com" },
  { match: /^Uber$/, website: "uber.com" },
  { match: /^Lyft$/, website: "lyft.com" },
  { match: /^Citi Bike$/, website: "citibikenyc.com" },
  { match: /^(MTA|OMNY)$/, website: "mta.info" },
  { match: /^Amtrak$/, website: "amtrak.com" },
  { match: /^Airbnb$/, website: "airbnb.com" },
  { match: /^Marriott$/, website: "marriott.com" },
  { match: /^TAP AIR PORTUGAL/, website: "flytap.com" },
  { match: /^UNITED /, website: "united.com" },
  { match: /^Netflix$/, website: "netflix.com" },
  { match: /SPOTIFY/, website: "spotify.com" },
  { match: /^The New York Times$/, website: "nytimes.com" },
  { match: /^WNYC$/, website: "wnyc.org" },
  { match: /^Con Edison$/, website: "coned.com" },
  { match: /^Verizon Fios$/, website: "verizon.com" },
  { match: /^T-Mobile$/, website: "t-mobile.com" },
  { match: /^Lemonade$/, website: "lemonade.com" },
  { match: /^One Medical$/, website: "onemedical.com", at: [40.6889, -73.9910] },
  { match: /^Ticketmaster$/, website: "ticketmaster.com" },
  { match: /^USPS$/, website: "usps.com", at: [40.6797, -73.9781] },
  { match: /^Venmo$/, website: "venmo.com" },
];

/** Where each trip happened, for the meals and rides there. */
const TRIP_CENTER: Record<(typeof TRIPS)[number]["place"], readonly [number, number]> = {
  Chicago: [41.8837, -87.6324],
  Boston: [42.3555, -71.0605],
  Lisbon: [38.7110, -9.1366],
  Montauk: [41.0359, -71.9545],
};

/** Plaid's details for this charge, and the notes and tags a careful person added. */
function detailsFor(e: Emit, day: Day): Pick<SampleTxn, "website" | "location" | "notes" | "tags"> {
  const name = e.merchant ?? e.description;
  const known = MERCHANT_DETAILS.find((d) => d.match.test(name));
  const trip = tripOn(day);
  const booked = tripBookedOn(day);
  const travel = e.plaid === C.flights || e.plaid === C.lodging || e.merchant === "Amtrak";
  // At home these are skipped on trip days, so on one they are the trip's (bills are not).
  const away = e.plaid === C.restaurant || e.plaid === C.rideshare || e.plaid === C.fxFee;
  const tripOf = booked && travel ? booked : trip && away ? trip : undefined;
  // Spending on a trip happens there; the ledger says so with a tag.
  const at = known?.at ?? (trip && tripOf === trip && e.plaid !== C.fxFee ? TRIP_CENTER[trip.place] : undefined);
  return {
    website: known?.website ? `https://${known.website}` : null,
    location: at ? { lat: at[0], lon: at[1] } : null,
    notes: /CAT CLINIC/.test(name) ? "Miso's checkup and shots" : booked && travel ? `${booked.place} trip` : null,
    tags: tripOf ? [`trip-${tripOf.place.toLowerCase()}`] : [],
  };
}

const generators: Generator[] = [
  // --- Income -------------------------------------------------------------------------
  (day, rng) =>
    day.dom === 15 || isLastBusinessDay(day)
      ? [
          {
            merchant: "Acme Analytics",
            description: "ACME ANALYTICS INC DES:PAYROLL ID:" + digits(rng, 9) + " INDN:JORDAN REYES",
            amount: -3412.55,
            account: "chk",
            plaid: C.salary,
            type: "deposit",
          },
        ]
      : [],
  (day) =>
    // Sam is paid every other Friday.
    day.dow === 5 && Math.floor(day.epochDay / 7) % 2 === 0
      ? [
          {
            merchant: "City Health System",
            description: "CITY HEALTH SYSTEM DIR DEP",
            amount: -2288.4,
            account: "chk",
            plaid: C.salary,
            type: "deposit",
          },
        ]
      : [],
  (day, rng) =>
    day.dom === day.daysInMonth
      ? [
          {
            merchant: null,
            description: "INTEREST PAYMENT",
            amount: -cents(between(rng, 38, 52)),
            account: "sav",
            plaid: C.interest,
            type: "deposit",
          },
        ]
      : [],
  (day) =>
    day.month === 4 && day.dom === 9
      ? [
          {
            merchant: "IRS",
            description: "IRS TREAS 310 TAX REF",
            amount: -1184,
            account: "chk",
            plaid: C.taxRefund,
            type: "deposit",
          },
        ]
      : [],

  // --- Housing and utilities -------------------------------------------------------------
  (day) =>
    day.dom === 1
      ? [
          {
            merchant: "Bergen St Properties",
            description: "ACH DEBIT BERGEN ST PROPERTIES LLC RENT",
            amount: 3650,
            account: "chk",
            plaid: C.rent,
          },
        ]
      : [],
  (day, rng) =>
    isFirstBusinessDayFrom(day, 18)
      ? [{ merchant: "Con Edison", description: "CON ED OF NY INTELL CK", amount: conEdBill(day, rng), account: "jordan", plaid: C.power }]
      : [],
  (day) =>
    day.dom === 22
      ? [{ merchant: "Verizon Fios", description: "VERIZON*FIOS RECURRING", amount: 79.99, account: "jordan", plaid: C.internet }]
      : [],
  (day) =>
    day.dom === 9
      ? [{ merchant: "T-Mobile", description: "T-MOBILE*AUTO PAY", amount: 90, account: "sam", plaid: C.phone }]
      : [],
  (day) =>
    day.dom === 11
      ? [
          // Renters insurance; Plaid can't place Lemonade.
          { merchant: "Lemonade", description: "LEMONADE I* INSURANCE", amount: 12.5, account: "jordan", plaid: C.otherServices, truth: C.insurance },
        ]
      : [],

  // --- Subscriptions ---------------------------------------------------------------------
  (day) =>
    day.dom === 12 ? [{ merchant: "Netflix", description: "NETFLIX.COM", amount: 17.99, account: "sam", plaid: C.tv }] : [],
  (day) =>
    day.dom === 3
      ? [
          // Billed through PayPal, so Plaid sees a generic service.
          { merchant: null, description: "PAYPAL *SPOTIFY 4029357733", amount: 19.99, account: "jordan", plaid: C.otherServices, truth: C.music },
        ]
      : [],
  (day) =>
    day.dom === 5
      ? [{ merchant: "The New York Times", description: "NYTIMES*NYTIMES DIGITAL", amount: 25, account: "jordan", plaid: C.news }]
      : [],
  (day) =>
    day.dom === 7 ? [{ merchant: "WNYC", description: "NEW YORK PUBLIC RADIO", amount: 15, account: "sam", plaid: C.donations }] : [],
  (day) =>
    day.dom === 1
      ? [{ merchant: "Equinox", description: "EQUINOX 0291 MEMBERSHIP", amount: 260, account: "sam", plaid: C.gym }]
      : [],
  (day) =>
    day.dom === 17
      ? [{ merchant: null, description: "BLINK FITNESS 8812 BROOKLYN NY", amount: 24.99, account: "jordan", plaid: C.otherServices, truth: C.gym }]
      : [],

  // --- Getting around (no car) ------------------------------------------------------------
  (day) =>
    // Jordan: 30-day unlimited, bought on the first weekday of the month.
    isFirstBusinessDayFrom(day, 1)
      ? [{ merchant: "MTA", description: "MTA*NYCT PAYGO 30-DAY UNL", amount: 132, account: "jordan", plaid: C.transit }]
      : [],
  (day, rng) => {
    // Sam: pay-per-ride on OMNY, capped at 12 rides a week (Mon-Sun).
    if (tripOn(day)) return [];
    const rides = day.weekend ? (chance(rng, 0.5) ? 2 : 0) : chance(rng, 0.85) ? 2 : 1;
    const weekRides = (day.dow === 0 ? 6 : day.dow - 1) * 2; // rides already taken this week, roughly
    const paid = Math.max(0, Math.min(rides, 12 - weekRides));
    return Array.from({ length: paid }, () => ({
      merchant: "OMNY",
      description: "MTA*NYCT OMNY " + digits(rng, 6),
      amount: 2.9,
      account: "sam",
      plaid: C.transit,
    }));
  },
  (day) =>
    day.month === 4 && day.dom === 2
      ? [{ merchant: "Citi Bike", description: "LYFT *CITI BIKE ANNUAL MEMBER", amount: 219.99, account: "jordan", plaid: C.rideshare, truth: C.bikes }]
      : [],
  (day, rng) => {
    // E-bike minutes; Citi Bike bills through Lyft, so Plaid calls it a rideshare.
    const warm = day.month >= 4 && day.month <= 10;
    if (tripOn(day) || !chance(rng, warm ? 0.45 : 0.15)) return [];
    return [
      {
        merchant: "Citi Bike",
        description: "LYFT   *CITIBIKE RIDE " + ref(rng, 6),
        amount: cents(between(rng, 1.8, 6.4)),
        account: "jordan",
        plaid: C.rideshare,
        truth: C.bikes,
      },
    ];
  },
  (day, rng) =>
    (day.weekend ? chance(rng, 0.18) : chance(rng, 0.05)) && !tripOn(day)
      ? [
          chance(rng, 0.7)
            ? { merchant: "Uber", description: "UBER   *TRIP " + ref(rng, 8), amount: cents(between(rng, 14, 42)), account: "sam", plaid: C.rideshare }
            : { merchant: "Lyft", description: "LYFT   *RIDE " + ["FRI", "SAT", "SUN"][day.dow % 3] + " " + digits(rng, 1) + "PM", amount: cents(between(rng, 13, 36)), account: "jordan", plaid: C.rideshare },
        ]
      : [],

  // --- Food ------------------------------------------------------------------------------
  (day, rng) =>
    day.dow === 6 && !tripOn(day)
      ? [{ merchant: "Trader Joe's", description: "TRADER JOE S #558 BROOKLYN NY", amount: cents(between(rng, 64, 138)), account: "sam", plaid: C.groceries }]
      : [],
  (day, rng) =>
    chance(rng, 0.09) && !tripOn(day)
      ? [
          // The hot bar sometimes lands as a restaurant.
          {
            merchant: "Whole Foods Market",
            description: "WHOLEFDS BRK 10235",
            amount: cents(between(rng, 18, 104)),
            account: "jordan",
            ...(chance(rng, 0.3) ? { plaid: C.restaurant, truth: C.groceries } : { plaid: C.groceries }),
          },
        ]
      : [],
  (day, rng) =>
    day.dow === 3 && Math.floor(day.epochDay / 7) % 2 === 1 && !tripOn(day)
      ? [
          {
            merchant: "FreshDirect",
            description: "FRESHDIRECT " + digits(rng, 8),
            amount: cents(between(rng, 96, 182)),
            account: "sam",
            ...(chance(rng, 0.35) ? { plaid: C.marketplace, truth: C.groceries } : { plaid: C.groceries }),
          },
        ]
      : [],
  (day, rng) =>
    chance(rng, 0.4) && !tripOn(day)
      ? [
          // The corner deli: groceries, but Plaid sees a convenience store.
          {
            merchant: null,
            description: "SQ *PARK SLOPE DELI GROCERY " + digits(rng, 4) + " BROOKLYN NY",
            amount: cents(between(rng, 3.5, 19)),
            account: pick(rng, ["jordan", "sam"]),
            plaid: C.convenience,
            truth: C.groceries,
          },
        ]
      : [],
  (day, rng) =>
    !day.weekend && chance(rng, 0.6) && !tripOn(day)
      ? [
          (() => {
            const shop = pick(rng, COFFEE);
            return {
              merchant: shop.merchant,
              description: shop.desc,
              amount: cents(between(rng, 4.5, 7.75)),
              account: "jordan",
              plaid: shop.plaid ?? C.coffee,
              ...(shop.plaid ? { truth: C.coffee } : {}),
            };
          })(),
        ]
      : [],
  (day, rng) => {
    // Restaurants: about three a week, more on weekends.
    if (tripOn(day) || !chance(rng, day.dow >= 4 ? 0.55 : 0.3)) return [];
    const place = pick(rng, RESTAURANTS);
    return [
      {
        merchant: place.merchant,
        description: place.desc,
        amount: cents(between(rng, place.min, place.max)),
        account: pick(rng, ["jordan", "sam"]),
        plaid: place.merchant === "Shake Shack" ? C.fastFood : C.restaurant,
        tipped: true,
      },
    ];
  },
  (day, rng) =>
    chance(rng, 0.11) && !tripOn(day)
      ? [
          // Plaid files Uber Eats under Uber: a rideshare.
          {
            merchant: "Uber Eats",
            description: "UBER   *EATS " + ref(rng, 8),
            amount: cents(between(rng, 26, 58)),
            account: "sam",
            ...(chance(rng, 0.85) ? { plaid: C.rideshare, truth: C.restaurant } : { plaid: C.restaurant }),
          },
        ]
      : [],
  (day, rng) =>
    chance(rng, 0.12) && !tripOn(day)
      ? [{ merchant: "DoorDash", description: "DD *DOORDASH " + pick(rng, ["SZECHUANGOURMET", "JUNOON", "DIDDYRIESE", "THAIHOUSE"]), amount: cents(between(rng, 24, 61)), account: "jordan", plaid: C.restaurant }]
      : [],
  (day, rng) =>
    (day.dow === 5 || day.dow === 6) && chance(rng, 0.35) && !tripOn(day)
      ? [{ merchant: "The Gate", description: "THE GATE BAR BROOKLYN", amount: cents(between(rng, 24, 66)), account: "sam", plaid: C.booze }]
      : [],
  (day, rng) =>
    day.dom === 20 || (day.dom === 8 && chance(rng, 0.4))
      ? [{ merchant: "Slope Cellars", description: "SLOPE CELLARS", amount: cents(between(rng, 28, 74)), account: "jordan", plaid: C.booze }]
      : [],

  // --- Household --------------------------------------------------------------------------
  (day, rng) =>
    day.dow === 2 && !tripOn(day)
      ? [
          // Wash-and-fold; a Square merchant Plaid can't place.
          {
            merchant: null,
            description: "SQ *SUDS WASH AND FOLD " + digits(rng, 4) + " BROOKLYN NY",
            amount: cents(between(rng, 27, 43)),
            account: "sam",
            plaid: C.otherShopping,
            truth: C.laundry,
          },
        ]
      : [],
  (day, rng) =>
    chance(rng, 0.13)
      ? [{ merchant: "Amazon", description: "AMZN Mktp US*" + ref(rng, 9), amount: cents(between(rng, 9, 118)), account: "jordan", plaid: C.marketplace }]
      : [],
  (day, rng) =>
    chance(rng, 0.008)
      ? [{ merchant: "Amazon", description: "AMZN Mktp US*" + ref(rng, 9) + " RETURN", amount: -cents(between(rng, 14, 70)), account: "jordan", plaid: C.marketplace }]
      : [],
  (day, rng) =>
    chance(rng, 0.035)
      ? [{ merchant: "Target", description: "TARGET 00013474 BROOKLYN NY", amount: cents(between(rng, 24, 96)), account: "sam", plaid: C.superstore }]
      : [],
  (day, rng) =>
    chance(rng, 0.03)
      ? [{ merchant: "Uniqlo", description: "UNIQLO USA 5TH AVE", amount: cents(between(rng, 29, 160)), account: "sam", plaid: C.clothing }]
      : [],
  (day) =>
    day.month === 11 && day.dom === 4
      ? [{ merchant: "Uniqlo", description: "UNIQLO USA 5TH AVE RETURN", amount: -59.9, account: "sam", plaid: C.clothing }]
      : [],
  (day, rng) =>
    chance(rng, 0.02)
      ? [{ merchant: null, description: "SQ *BRKLYN HARDWARE " + digits(rng, 4), amount: cents(between(rng, 8, 46)), account: "jordan", plaid: C.hardware }]
      : [],
  (day, rng) =>
    day.dom === 14
      ? [{ merchant: "Chewy", description: "CHEWY.COM", amount: cents(between(rng, 44, 72)), account: "sam", plaid: C.petSupplies }]
      : [],
  (day, rng) =>
    (day.month === 2 && day.dom === 19) || (day.month === 9 && day.dom === 10)
      ? [
          // The cat's checkups; Plaid sees a clinic and assumes people.
          { merchant: null, description: "SQ *BROOKLYN CAT CLINIC", amount: cents(between(rng, 180, 420)), account: "sam", plaid: C.doctor, truth: C.vet },
        ]
      : [],
  (day, rng) =>
    chance(rng, 0.012)
      ? [{ merchant: "USPS", description: "USPS PO 3512340215", amount: cents(between(rng, 6, 24)), account: "jordan", plaid: C.shipping }]
      : [],

  // --- Health and personal care -------------------------------------------------------------
  (day, rng) =>
    chance(rng, 0.07)
      ? [{ merchant: "CVS", description: "CVS/PHARMACY #02811", amount: cents(between(rng, 6, 42)), account: pick(rng, ["jordan", "sam"]), plaid: C.pharmacy }]
      : [],
  (day) =>
    day.month === 2 && day.dom === 3
      ? [{ merchant: "One Medical", description: "ONE MEDICAL MEMBERSHIP", amount: 199, account: "jordan", plaid: C.doctor }]
      : [],
  (day, rng) =>
    (day.month === 5 && day.dom === 13) || (day.month === 11 && day.dom === 18)
      ? [{ merchant: null, description: "SQ *PARK SLOPE DENTAL", amount: cents(between(rng, 40, 160)), account: "sam", plaid: C.dentist }]
      : [],
  (day, rng) =>
    day.dom === 6 || day.dom === 27
      ? [{ merchant: null, description: "SQ *FRESH CUTS BARBERSHOP", amount: cents(between(rng, 42, 52)), account: "jordan", plaid: C.hair }]
      : [],

  // --- Fun --------------------------------------------------------------------------------
  (day, rng) =>
    day.weekend && chance(rng, 0.08)
      ? [{ merchant: "Alamo Drafthouse", description: "ALAMO DRAFTHOUSE BKLYN", amount: cents(between(rng, 32, 64)), account: "sam", plaid: C.tv }]
      : [],
  (day, rng) =>
    day.dom === 2 && (day.month === 2 || day.month === 5 || day.month === 10)
      ? [{ merchant: "Ticketmaster", description: "TICKETMASTER " + digits(rng, 10), amount: cents(between(rng, 90, 240)), account: "jordan", plaid: C.events }]
      : [],
  (day, rng) =>
    day.weekend && chance(rng, 0.03)
      ? [{ merchant: "Brooklyn Museum", description: "BROOKLYN MUSEUM ADMISSIONS", amount: 40, account: "sam", plaid: C.events }]
      : [],

  // --- Travel -------------------------------------------------------------------------------
  (day, rng) => {
    const trip = tripBookedOn(day);
    if (!trip) return [];
    const out: Emit[] = [];
    if ("fly" in trip) {
      out.push({ merchant: null, description: `${trip.fly} ${digits(rng, 13)}`, amount: cents(between(rng, 380, 1320)), account: "jordan", plaid: C.flights });
    }
    if ("train" in trip) {
      // Amtrak: Plaid sees a train and files it as transit.
      out.push({ merchant: "Amtrak", description: "AMTRAK .COM " + digits(rng, 7), amount: cents(between(rng, 140, 290)), account: "jordan", plaid: C.transit, truth: C.otherTravel });
    }
    out.push(
      trip.stay === "AIRBNB"
        ? { merchant: "Airbnb", description: "AIRBNB * HM" + ref(rng, 8), amount: cents(between(rng, 640, 1480)), account: "sam", plaid: C.lodging }
        : { merchant: "Marriott", description: "MARRIOTT " + trip.place.toUpperCase(), amount: cents(between(rng, 420, 880)), account: "sam", plaid: C.lodging },
    );
    return out;
  },
  (day, rng) => {
    const trip = tripOn(day);
    if (!trip) return [];
    const out: Emit[] = [];
    const meals = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < meals; i += 1) {
      const amount = cents(between(rng, 22, 95));
      out.push({ merchant: null, description: `${pick(rng, ["CAFE", "TASCA", "BISTRO", "TAQUERIA"])} ${trip.place.toUpperCase()} ${digits(rng, 4)}`, amount, account: "jordan", plaid: C.restaurant, tipped: true });
      if ("abroad" in trip) {
        out.push({ merchant: null, description: "FOREIGN TRANSACTION FEE", amount: cents(amount * 0.03), account: "jordan", plaid: C.fxFee });
      }
    }
    if (chance(rng, 0.5)) {
      out.push({ merchant: "Uber", description: "UBER   *TRIP " + ref(rng, 8), amount: cents(between(rng, 11, 34)), account: "sam", plaid: C.rideshare });
    }
    return out;
  },
  (day) =>
    day.month === 7 && day.dom === 2
      ? [{ merchant: null, description: "TAP AIR PORTUGAL CREDIT", amount: -86, account: "jordan", plaid: C.flights }]
      : [],

  // --- Money moving between people and accounts -----------------------------------------------
  (day, rng) =>
    chance(rng, 0.06)
      ? [
          // Paying friends back for dinners: Plaid can only say "transfer".
          { merchant: "Venmo", description: "VENMO PAYMENT " + digits(rng, 10), amount: cents(between(rng, 18, 85)), account: "chk", plaid: C.toApps, truth: C.restaurant },
        ]
      : [],
  (day, rng) =>
    chance(rng, 0.025)
      ? [{ merchant: "Venmo", description: "VENMO CASHOUT " + digits(rng, 10), amount: -cents(between(rng, 20, 120)), account: "chk", plaid: C.fromApps, type: "deposit" }]
      : [],
  (day, rng) =>
    chance(rng, 0.015)
      ? [
          { merchant: null, description: "NON-CHASE ATM WITHDRAW " + digits(rng, 6) + " BROOKLYN NY", amount: pick(rng, [40, 60, 100]), account: "chk", plaid: C.cash },
          { merchant: null, description: "NON-CHASE ATM FEE-WITH", amount: 3.5, account: "chk", plaid: C.atmFee },
        ]
      : [],
  (day) =>
    day.dom === 2
      ? [{ merchant: null, description: "ONLINE TRANSFER TO SAV ...9021", amount: 1000, account: "chk", plaid: C.toSavings, type: "transfer", counterparty: accountName("sav") }]
      : [],
  (day, rng) =>
    day.dom === 25
      ? [
          { merchant: null, description: "PAYMENT TO CHASE CARD ENDING IN 3308", amount: cents(between(rng, 1700, 3100)), account: "chk", plaid: C.ccPayment, type: "transfer", counterparty: accountName("jordan") },
          { merchant: null, description: "CITI AUTOPAY PAYMENT 7725", amount: cents(between(rng, 1400, 2600)), account: "chk", plaid: C.ccPayment, type: "transfer", counterparty: accountName("sam") },
        ]
      : [],
];

// ---------------------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/** Transactions dated `iso`, as of `endDate` (the last day of data; later days are pending). */
export function generateDay(seed: number, iso: string, endDate: string): SampleTxn[] {
  const day = toDay(iso);
  const out: SampleTxn[] = [];
  const counts = new Map<string, number>();
  generators.forEach((gen, g) => {
    // One stream per generator, so adding a generator never reshuffles the others.
    const rng = prng(hashString(`${seed}|${iso}|${g}`));
    for (const e of gen(day, rng)) {
      const name = e.merchant ?? e.description;
      const base = `s:${iso}:${slug(name)}`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      const id = n === 1 ? base : `${base}:${n}`;
      const daysOld = toDay(endDate).epochDay - day.epochDay;
      // Card charges from the last two days are still pending; restaurants post a few days
      // later, after the tip, replacing their pending authorization.
      const isCard = e.account === "jordan" || e.account === "sam";
      const pending = isCard && daysOld < (e.tipped ? 4 : 2);
      const type = e.type ?? (e.amount < 0 ? "deposit" : "withdrawal");
      out.push({
        externalId: pending ? `${id}~pending` : id,
        date: iso,
        amount: -e.amount,
        type,
        pending,
        merchant: e.merchant,
        description: e.description,
        accountId: e.account,
        accountName: accountName(e.account),
        counterparty: e.counterparty ?? e.merchant,
        plaid: { primary: e.plaid[0], detailed: e.plaid[1] },
        truth: { primary: (e.truth ?? e.plaid)[0], detailed: (e.truth ?? e.plaid)[1] },
        replacesExternalId: !pending && isCard && e.tipped && daysOld < 10 ? `${id}~pending` : null,
        ...detailsFor(e, day),
      });
    }
  });
  return out;
}

/** Twelve months of transactions ending on `endDate` (inclusive), oldest first. */
export function generateSample(seed: number, endDate: string, days = 365): SampleTxn[] {
  const out: SampleTxn[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(...generateDay(seed, addDays(endDate, -i), endDate));
  return out;
}
