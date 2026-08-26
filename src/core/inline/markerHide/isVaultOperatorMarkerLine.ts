/**
 * isVaultOperatorMarkerLine -- erkennt eine vault-operator-Auto-Block-
 * Markerzeile (FIX-19-09-05).
 *
 * Deckungsgleich mit NEW_START_RE / NEW_END_RE in MOCMaintainer.ts: die Marker
 * sind ZEILEN-VERANKERT (^\s*...\s*$), ein Marker zaehlt nur, wenn er der
 * einzige Inhalt der Zeile ist. Reine Funktion (kein CM6-Import), damit sie
 * ohne Editor-Harness getestet werden kann und die Extension schlank bleibt.
 *
 * Absichtlich NICHT gematcht: das Legacy-obsilo-Format -- ein sichtbar
 * gebliebener Alt-Marker signalisiert, dass die Note noch nicht migriert ist.
 */

const MARKER_START = /^\s*<!--\s*vault-operator:[A-Za-z0-9_-]+\s*-->\s*$/;
const MARKER_END = /^\s*<!--\s*\/vault-operator:[A-Za-z0-9_-]+(?:\s+sha="[^"]*")?\s*-->\s*$/;

/** True, wenn die GANZE Zeile ein vault-operator-Start- oder End-Marker ist. */
export function isVaultOperatorMarkerLine(line: string): boolean {
    return MARKER_START.test(line) || MARKER_END.test(line);
}
