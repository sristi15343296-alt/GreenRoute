/**
 * Turning what the driver types into a unit code.
 *
 * Demo dispatch issues one code per vehicle in the form `token-med12`, while the
 * crew knows the vehicle only as `MED-12`. The login screen therefore derives
 * the code from the call sign, and falls back to trying the typed call sign
 * itself so a dispatcher that hands out real codes keeps working.
 *
 * The PIN is not sent anywhere: it is the unlock code for this device, hashed
 * in SecureStore.
 */

/** `MED-12` → `token-med12`. */
export function unitCodeFor(callSign: string): string {
  const slug = callSign.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return `token-${slug}`;
}

/** A call sign is letters, an optional dash, then digits: MED-12, FIRE3, R-7. */
export function isValidCallSign(value: string): boolean {
  return /^[A-Za-z]{2,6}-?\d{1,3}$/.test(value.trim());
}

export function isValidPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}
