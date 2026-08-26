/**
 * markerHideExtension -- blendet vault-operator-Auto-Block-Markerzeilen im
 * CodeMirror-6-Editor aus (FIX-19-09-05, USER 2026-07-21).
 *
 * Die Marker (<!-- vault-operator:incoming-links -->, <!-- /vault-operator:... -->,
 * <!-- vault-operator:backlinks-base --> usw.) sind eine technische Notwendigkeit
 * (Block-Grenzen + sha-Guard), stoeren aber im Edit-Modus. Die Nutzerin arbeitet
 * fast nur in Source/Live-Preview, wo der Lesemodus-Hinweis "dort unsichtbar"
 * nicht hilft. Diese Extension gibt jeder reinen Markerzeile eine CSS-Klasse
 * (.vault-operator-hidden-marker), die styles.css auf blass/kollabiert setzt --
 * gezielt NUR unsere Marker, andere HTML-Kommentare bleiben normal.
 *
 * Bot-Compliance: kein DOM-Zugriff, kein innerHTML, keine Style-Mutation --
 * nur Decoration.line mit einer CSS-Klasse aus styles.css. Rein additiv; wenn
 * die Registrierung fehlschlaegt, faellt der Editor auf sein Normalverhalten
 * zurueck (Marker sichtbar).
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
    Decoration,
    ViewPlugin,
    type DecorationSet,
    type EditorView,
    type ViewUpdate,
} from '@codemirror/view';
import { isVaultOperatorMarkerLine } from './isVaultOperatorMarkerLine';

/** CSS-Klasse (styles.css) fuer eine ausgeblendete Markerzeile. */
const HIDDEN_MARKER_CLASS = 'vault-operator-hidden-marker';

const hiddenLineDeco = Decoration.line({ class: HIDDEN_MARKER_CLASS });

/**
 * Baut das Decoration-Set fuer den aktuell sichtbaren Bereich: jede Zeile, die
 * eine vault-operator-Markerzeile ist, bekommt die Hidden-Klasse. Nur sichtbare
 * Zeilen werden geprueft (viewport-lokal), also O(sichtbare Zeilen).
 */
function buildMarkerDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            if (isVaultOperatorMarkerLine(line.text)) {
                builder.add(line.from, line.from, hiddenLineDeco);
            }
            pos = line.to + 1;
        }
    }
    return builder.finish();
}

/**
 * CodeMirror-Extension: haelt die Marker-Decorations ueber Edits und
 * Viewport-Aenderungen aktuell.
 */
export function markerHideExtension(): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            constructor(view: EditorView) {
                this.decorations = buildMarkerDecorations(view);
            }
            update(u: ViewUpdate): void {
                if (u.docChanged || u.viewportChanged) {
                    this.decorations = buildMarkerDecorations(u.view);
                }
            }
        },
        { decorations: (v) => v.decorations },
    );
}
