/**
 * Plaid's personal finance category taxonomy (PFC v2), as the seed of the category tree.
 *
 * Top-level names are the names the Plaid connector writes as the backend category for each
 * primary category, so a backend category maps back onto the tree by name. Leaf names are
 * unique across the whole tree, because a flat backend stores only a name.
 */
export type CategoryKind = "expense" | "income" | "transfer";

export interface TaxonomyPrimary {
  primary: string;
  name: string;
  kind: CategoryKind;
  detailed: Array<[detailed: string, name: string]>;
}

export const PLAID_TAXONOMY: TaxonomyPrimary[] = [
  {
    primary: "INCOME",
    name: "Income",
    kind: "income",
    detailed: [
      ["CHILD_SUPPORT", "Child support"],
      ["CONTRACTOR", "Contract work"],
      ["DIVIDENDS", "Dividends"],
      ["GIG_ECONOMY", "Gig work"],
      ["INTEREST_EARNED", "Interest earned"],
      ["LONG_TERM_DISABILITY", "Disability"],
      ["MILITARY", "Military pay"],
      ["RENTAL", "Rental income"],
      ["RETIREMENT_PENSION", "Pension"],
      ["SALARY", "Salary"],
      ["TAX_REFUND", "Tax refund"],
      ["UNEMPLOYMENT", "Unemployment"],
      ["OTHER", "Other income"],
    ],
  },
  {
    primary: "LOAN_DISBURSEMENTS",
    name: "Loan Disbursements",
    kind: "transfer",
    detailed: [
      ["AUTO", "Auto loan disbursement"],
      ["BNPL", "Buy now, pay later disbursement"],
      ["CASH_ADVANCES", "Cash advance disbursement"],
      ["EWA", "Earned wage access"],
      ["MORTGAGE", "Mortgage disbursement"],
      ["PERSONAL", "Personal loan disbursement"],
      ["STUDENT", "Student loan disbursement"],
      ["OTHER_DISBURSEMENT", "Other disbursement"],
    ],
  },
  {
    primary: "LOAN_PAYMENTS",
    name: "Loan Payments",
    kind: "transfer",
    detailed: [
      ["CAR_PAYMENT", "Car payment"],
      ["BNPL", "Buy now, pay later payment"],
      ["CASH_ADVANCES", "Cash advance repayment"],
      ["CREDIT_CARD_PAYMENT", "Credit card payment"],
      ["EWA", "Earned wage access repayment"],
      ["MORTGAGE_PAYMENT", "Mortgage payment"],
      ["PERSONAL_LOAN_PAYMENT", "Personal loan payment"],
      ["STUDENT_LOAN_PAYMENT", "Student loan payment"],
      ["OTHER_PAYMENT", "Other loan payment"],
    ],
  },
  {
    primary: "TRANSFER_IN",
    name: "Transfer In",
    kind: "transfer",
    detailed: [
      ["ACCOUNT_TRANSFER", "Transfer from another account"],
      ["DEPOSIT", "Cash or check deposit"],
      ["INVESTMENT_AND_RETIREMENT_FUNDS", "From investments"],
      ["SAVINGS", "From savings"],
      ["TRANSFER_IN_FROM_APPS", "From payment apps"],
      ["WIRE", "Incoming wire"],
      ["OTHER_TRANSFER_IN", "Other transfer in"],
    ],
  },
  {
    primary: "TRANSFER_OUT",
    name: "Transfer Out",
    kind: "transfer",
    detailed: [
      ["ACCOUNT_TRANSFER", "Transfer to another account"],
      ["CRYPTO", "Crypto"],
      ["INVESTMENT_AND_RETIREMENT_FUNDS", "To investments"],
      ["SAVINGS", "To savings"],
      ["TRANSFER_OUT_FROM_APPS", "To payment apps"],
      ["WIRE", "Outgoing wire"],
      ["WITHDRAWAL", "Cash withdrawal"],
      ["OTHER_TRANSFER_OUT", "Other transfer out"],
    ],
  },
  {
    primary: "BANK_FEES",
    name: "Bank Fees",
    kind: "expense",
    detailed: [
      ["ATM_FEES", "ATM fees"],
      ["INSUFFICIENT_FUNDS", "Insufficient funds fees"],
      ["INTEREST_CHARGE", "Interest charges"],
      ["FOREIGN_TRANSACTION_FEES", "Foreign transaction fees"],
      ["OVERDRAFT_FEES", "Overdraft fees"],
      ["LATE_FEES", "Late fees"],
      ["CASH_ADVANCE", "Cash advance fees"],
      ["OTHER_BANK_FEES", "Other bank fees"],
    ],
  },
  {
    primary: "ENTERTAINMENT",
    name: "Entertainment",
    kind: "expense",
    detailed: [
      ["CASINOS_AND_GAMBLING", "Gambling"],
      ["MUSIC_AND_AUDIO", "Music and audio"],
      ["SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "Events and museums"],
      ["TV_AND_MOVIES", "TV and movies"],
      ["VIDEO_GAMES", "Video games"],
      ["OTHER_ENTERTAINMENT", "Other entertainment"],
    ],
  },
  {
    primary: "FOOD_AND_DRINK",
    name: "Food and Drink",
    kind: "expense",
    detailed: [
      ["BEER_WINE_AND_LIQUOR", "Beer, wine and liquor"],
      ["COFFEE", "Coffee"],
      ["FAST_FOOD", "Fast food"],
      ["GROCERIES", "Groceries"],
      ["RESTAURANT", "Restaurants"],
      ["VENDING_MACHINES", "Vending machines"],
      ["OTHER_FOOD_AND_DRINK", "Other food and drink"],
    ],
  },
  {
    primary: "GENERAL_MERCHANDISE",
    name: "Shopping",
    kind: "expense",
    detailed: [
      ["BOOKSTORES_AND_NEWSSTANDS", "Books and news"],
      ["CLOTHING_AND_ACCESSORIES", "Clothing"],
      ["CONVENIENCE_STORES", "Convenience stores"],
      ["DEPARTMENT_STORES", "Department stores"],
      ["DISCOUNT_STORES", "Discount stores"],
      ["ELECTRONICS", "Electronics"],
      ["GIFTS_AND_NOVELTIES", "Gifts"],
      ["OFFICE_SUPPLIES", "Office supplies"],
      ["ONLINE_MARKETPLACES", "Online marketplaces"],
      ["PET_SUPPLIES", "Pet supplies"],
      ["SPORTING_GOODS", "Sporting goods"],
      ["SUPERSTORES", "Superstores"],
      ["TOBACCO_AND_VAPE", "Tobacco and vape"],
      ["OTHER_GENERAL_MERCHANDISE", "Other shopping"],
    ],
  },
  {
    primary: "HOME_IMPROVEMENT",
    name: "Home Improvement",
    kind: "expense",
    detailed: [
      ["FURNITURE", "Furniture"],
      ["HARDWARE", "Hardware"],
      ["REPAIR_AND_MAINTENANCE", "Repairs and maintenance"],
      ["SECURITY", "Home security"],
      ["OTHER_HOME_IMPROVEMENT", "Other home improvement"],
    ],
  },
  {
    primary: "MEDICAL",
    name: "Medical",
    kind: "expense",
    detailed: [
      ["DENTAL_CARE", "Dental care"],
      ["EYE_CARE", "Eye care"],
      ["NURSING_CARE", "Nursing care"],
      ["PHARMACIES_AND_SUPPLEMENTS", "Pharmacy"],
      ["PRIMARY_CARE", "Doctor"],
      ["VETERINARY_SERVICES", "Vet"],
      ["OTHER_MEDICAL", "Other medical"],
    ],
  },
  {
    primary: "PERSONAL_CARE",
    name: "Personal Care",
    kind: "expense",
    detailed: [
      ["GYMS_AND_FITNESS_CENTERS", "Gym and fitness"],
      ["HAIR_AND_BEAUTY", "Hair and beauty"],
      ["LAUNDRY_AND_DRY_CLEANING", "Laundry and dry cleaning"],
      ["OTHER_PERSONAL_CARE", "Other personal care"],
    ],
  },
  {
    primary: "GENERAL_SERVICES",
    name: "Services",
    kind: "expense",
    detailed: [
      ["ACCOUNTING_AND_FINANCIAL_PLANNING", "Accounting and financial planning"],
      ["AUTOMOTIVE", "Automotive services"],
      ["CHILDCARE", "Childcare"],
      ["CONSULTING_AND_LEGAL", "Legal and consulting"],
      ["EDUCATION", "Education"],
      ["INSURANCE", "Insurance"],
      ["POSTAGE_AND_SHIPPING", "Postage and shipping"],
      ["STORAGE", "Storage"],
      ["OTHER_GENERAL_SERVICES", "Other services"],
    ],
  },
  {
    primary: "GOVERNMENT_AND_NON_PROFIT",
    name: "Government and Non-Profit",
    kind: "expense",
    detailed: [
      ["DONATIONS", "Donations"],
      ["GOVERNMENT_DEPARTMENTS_AND_AGENCIES", "Government fees"],
      ["TAX_PAYMENT", "Taxes"],
      ["OTHER_GOVERNMENT_AND_NON_PROFIT", "Other government and non-profit"],
    ],
  },
  {
    primary: "TRANSPORTATION",
    name: "Transportation",
    kind: "expense",
    detailed: [
      ["BIKES_AND_SCOOTERS", "Bikes and scooters"],
      ["GAS", "Gas"],
      ["PARKING", "Parking"],
      ["PUBLIC_TRANSIT", "Public transit"],
      ["TAXIS_AND_RIDE_SHARES", "Taxis and rideshare"],
      ["TOLLS", "Tolls"],
      ["OTHER_TRANSPORTATION", "Other transportation"],
    ],
  },
  {
    primary: "TRAVEL",
    name: "Travel",
    kind: "expense",
    detailed: [
      ["FLIGHTS", "Flights"],
      ["LODGING", "Lodging"],
      ["RENTAL_CARS", "Rental cars"],
      ["OTHER_TRAVEL", "Other travel"],
    ],
  },
  {
    primary: "RENT_AND_UTILITIES",
    name: "Rent and Utilities",
    kind: "expense",
    detailed: [
      ["GAS_AND_ELECTRICITY", "Gas and electricity"],
      ["INTERNET_AND_CABLE", "Internet and cable"],
      ["RENT", "Rent"],
      ["SEWAGE_AND_WASTE_MANAGEMENT", "Sewage and waste"],
      ["TELEPHONE", "Phone"],
      ["WATER", "Water"],
      ["OTHER_UTILITIES", "Other utilities"],
    ],
  },
  {
    primary: "OTHER",
    name: "Other",
    kind: "expense",
    detailed: [["OTHER", "Uncategorized other"]],
  },
];

export const kebab = (value: string): string => value.toLowerCase().replace(/_/g, "-");

/** Tree id of a Plaid primary category, e.g. `food-and-drink`. */
export const primaryCategoryId = (primary: string): string => kebab(primary);

/** Tree id of a Plaid detailed category, e.g. `food-and-drink.groceries`. */
export const detailedCategoryId = (primary: string, detailed: string): string =>
  `${kebab(primary)}.${kebab(detailed)}`;

export interface SeedCategory {
  id: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  plaidPrimary: string;
  plaidDetailed: string | null;
  sort: number;
}

export function taxonomySeed(): SeedCategory[] {
  const out: SeedCategory[] = [];
  PLAID_TAXONOMY.forEach((p, i) => {
    const parentId = primaryCategoryId(p.primary);
    out.push({
      id: parentId,
      parentId: null,
      name: p.name,
      kind: p.kind,
      plaidPrimary: p.primary,
      plaidDetailed: null,
      sort: i * 100,
    });
    p.detailed.forEach(([detailed, name], j) => {
      out.push({
        id: detailedCategoryId(p.primary, detailed),
        parentId,
        name,
        kind: p.kind,
        plaidPrimary: p.primary,
        plaidDetailed: detailed,
        sort: i * 100 + j + 1,
      });
    });
  });
  return out;
}

/** The backend name of a Plaid primary category, as the connector writes it. */
export function primaryName(primary: string): string | null {
  return PLAID_TAXONOMY.find((p) => p.primary === primary)?.name ?? null;
}
