/**
 * Process-wide readiness flag. Flipped to false on SIGTERM so /readyz reports 503
 * during drain (§O2) even before dependencies are torn down.
 */
let acceptingTraffic = true;

export function isAcceptingTraffic(): boolean {
  return acceptingTraffic;
}

export function beginDraining(): void {
  acceptingTraffic = false;
}
