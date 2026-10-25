// Petit générateur de PDF texte (polices standard, encodage WinAnsi) pour les documents fictifs des
// tests. Aucune dépendance : les octets sont écrits à la main, avec la table des références.

// Caractères hors Latin-1 courants en français → code WinAnsi.
const WIN_ANSI: Record<string, number> = {
    '’': 0x92,
    '‘': 0x91,
    '“': 0x93,
    '”': 0x94,
    '…': 0x85,
    '–': 0x96,
    '—': 0x97,
    œ: 0x9c,
    Œ: 0x8c,
    '€': 0x80
};

function encode(text: string): number[] {
    const bytes: number[] = [];
    for (const ch of text) {
        const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
        bytes.push(code <= 0xff ? code : 0x3f); // « ? » pour l'inconnu
    }
    return bytes;
}

function pdfString(text: string): number[] {
    const out: number[] = [0x28];
    for (const byte of encode(text)) {
        if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c);
        out.push(byte);
    }
    out.push(0x29);
    return out;
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Construit un PDF dont chaque page contient les lignes données. */
export function buildTextPdf(pages: string[][]): Uint8Array {
    const objects: number[][] = [];
    const fontId = 3;
    const pageIds = pages.map((_, i) => 4 + i * 2);
    objects[1] = ascii('<< /Type /Catalog /Pages 2 0 R >>');
    objects[2] = ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    objects[fontId] = ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    pages.forEach((lines, i) => {
        const pageId = pageIds[i] as number;
        const contentId = pageId + 1;
        const stream: number[] = ascii('BT /F1 11 Tf 15 TL 56 750 Td\n');
        for (const line of lines) {
            stream.push(...pdfString(line), ...ascii(' Tj T*\n'));
        }
        stream.push(...ascii('ET'));
        objects[pageId] = ascii(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
        );
        objects[contentId] = [...ascii(`<< /Length ${stream.length} >>\nstream\n`), ...stream, ...ascii('\nendstream')];
    });

    const out: number[] = ascii('%PDF-1.4\n');
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
        offsets[id] = out.length;
        out.push(...ascii(`${id} 0 obj\n`), ...(objects[id] as number[]), ...ascii('\nendobj\n'));
    }
    const xref = out.length;
    out.push(...ascii(`xref\n0 ${objects.length}\n0000000000 65535 f \n`));
    for (let id = 1; id < objects.length; id++) out.push(...ascii(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`));
    out.push(...ascii(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return Uint8Array.from(out);
}
