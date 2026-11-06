/**
 * GSTIN and Udyam checks. These are the real, public rules (format and checksum), so they work on
 * any number. What a GSTIN is registered as comes from the MOCK registry, not from here.
 */

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GST state and union territory codes, as published by the GST Council (25 and 26 were merged into 27 in 2020 but still appear on old numbers). */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
  "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "25": "Daman and Diu", "26": "Dadra and Nagar Haveli", "27": "Maharashtra", "28": "Andhra Pradesh (old)", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
  "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "97": "Other Territory", "99": "Centre Jurisdiction",
};

/** 4th character of a PAN: the kind of holder. */
const PAN_HOLDER_TYPES = "ABCFGHJKLPT";

const GSTIN_FORMAT = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** The check character: Luhn mod 36 over the first 14 characters, as GSTN specifies. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const product = BASE36.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = "FORMAT" | "STATE_CODE" | "PAN_HOLDER_TYPE" | "CHECKSUM";

export interface GstinResult {
  valid: boolean;
  gstin: string;
  problem?: GstinProblem;
  reason?: string;
  stateCode?: string;
  stateName?: string;
  pan?: string;
}

export function validateGstin(input: string): GstinResult {
  const gstin = input.trim().toUpperCase();
  const match = GSTIN_FORMAT.exec(gstin);
  if (!match) return { valid: false, gstin, problem: "FORMAT", reason: "A GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity number, the letter Z and a check character" };
  const [, stateCode = "", pan = ""] = match;
  const stateName = GST_STATES[stateCode];
  if (!stateName) return { valid: false, gstin, problem: "STATE_CODE", reason: `${stateCode} is not a GST state code` };
  if (!PAN_HOLDER_TYPES.includes(pan.charAt(3))) return { valid: false, gstin, problem: "PAN_HOLDER_TYPE", reason: `The PAN inside it has holder type ${pan.charAt(3)}, which does not exist` };
  const expected = gstinCheckDigit(gstin.slice(0, 14));
  if (expected !== gstin.charAt(14)) return { valid: false, gstin, problem: "CHECKSUM", reason: `The check character should be ${expected}, not ${gstin.charAt(14)}: the number was mistyped or made up` };
  return { valid: true, gstin, stateCode, stateName, pan };
}

const UDYAM_FORMAT = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

/** Format only. Udyam has no checksum, and checking it exists would need the real Udyam portal. */
export function validateUdyam(input: string): { valid: boolean; udyam: string; reason?: string } {
  const udyam = input.trim().toUpperCase();
  return UDYAM_FORMAT.test(udyam) ? { valid: true, udyam } : { valid: false, udyam, reason: "A Udyam number looks like UDYAM-MH-12-1234567" };
}
