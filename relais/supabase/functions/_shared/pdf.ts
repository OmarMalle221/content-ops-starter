// Lecture du texte d'un PDF, côté serveur (aucun envoi : le texte est pseudonymisé ensuite).
import { extractTextItems, getDocumentProxy } from 'unpdf';

export interface PdfText {
    pageCount: number;
    /** Texte de chaque page, une ligne du document par ligne. */
    pages: string[];
}

/** Lève une erreur si le fichier n'est pas un PDF lisible (chiffré, corrompu). */
export async function readPdfText(bytes: Uint8Array): Promise<PdfText> {
    // pdf.js peut détacher le tampon reçu : on lui passe une copie.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
        const { totalPages, items } = await extractTextItems(pdf);
        const pages = items.map((pageItems) => {
            let text = '';
            let lastY: number | null = null;
            for (const item of pageItems) {
                if (lastY !== null && Math.abs(item.y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
                text += item.str;
                if (item.hasEOL) text += '\n';
                lastY = item.y;
            }
            return text
                .split('\n')
                .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
                .filter((line, i, lines) => line !== '' || (i > 0 && lines[i - 1] !== ''))
                .join('\n')
                .trim();
        });
        return { pageCount: totalPages, pages };
    } finally {
        await pdf.cleanup();
    }
}
